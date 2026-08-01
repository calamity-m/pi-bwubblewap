# Spec: pi-bwubblewap: Bubblewrap sandboxing extension for Pi

Audience: engineers who will design and build this, and reviewers deciding
whether it's the right thing to build. Every requirement is testable; every
open question is either resolved or explicitly listed. No implementation
tasks — this document defines done, not how to get there.

- **Repo/System**: pi-bwubblewap
- **Created**: 2026-07-27
- **Status**: in-review _(draft / in-review / accepted / superseded)_

## Problem

Pi executes model-driven built-in tool calls (`bash`, `read`, `write`, `edit`,
`grep`, `find`, `ls`) directly on the host with the user's full permissions.
The user's current mitigation is regex-based permission rules in
`settings.json` (prompt on `docker`, `curl`,
`python -c`, `.env` access), which match command *spelling*, not behavior — a
`python -c` payload, a base64-decoded script, or a symlink trivially bypasses
them. The host holds real secrets the agent must never read (`~/.ssh`,
`~/.gnupg`, `~/.password-store`, client-certificate p12 files used by the
pi-mtls extension, GNOME Keyring via `$XDG_RUNTIME_DIR`). Existing options are
unsatisfying: full-container isolation breaks host-resident extensions like
pi-mtls (secrets would have to be mounted into agent reach), and the two
prior-art tool-level sandboxes depend on `@anthropic-ai/sandbox-runtime`, a
heavyweight third-party dependency.

## Goals

- Model-driven `bash` commands run inside a kernel-enforced bubblewrap
  sandbox: reads of configured secret paths fail, writes outside an allowlist
  fail, regardless of how the command is spelled or what it spawns.
- The same filesystem policy governs all Pi built-in tools. `read`, `write`,
  and `edit` enforce it through policy-aware operations; `grep`, `find`, and
  `ls` execute against the sandboxed filesystem view, so the model cannot
  bypass the boundary by choosing a different built-in tool.
- Pi itself, and extensions running in the pi process (pi-mtls, autoformatter),
  keep full host access — the boundary sits between the pi process and
  model-driven tool execution.
- A legitimate need to escape the sandbox is a first-class flow: per-call
  escalation with user approval, plus a configurable pre-approved allowlist.
- Network egress from sandboxed commands is deny-by-default, with a
  domain allowlist (GitHub and npm out of the box) enforced by a host-side
  filtering proxy — full network access is an escalation, not the default.
- The sandbox mechanism is a replaceable backend behind a stable policy
  interface, and this spec defines a Docker-based fallback backend in enough
  detail to build it if bubblewrap proves untenable on a target host (e.g.
  bwrap cannot be installed, or unprivileged user namespaces are disabled).

## Non-goals

- **Sandboxing pi itself or extension-provided tools** — extensions already
  execute in-process with full user permissions; pi's own trust boundary for
  extension installation is out of scope. Model-callable tools added by
  extensions are trusted and are not automatically governed by this policy.
- **Sanitizing the host environment** — sandboxed commands inherit pi's
  environment. Environment variables are part of the trusted host boundary;
  users must not keep long-lived secrets in them. The extension only replaces
  proxy variables as required to enforce network policy.
- **Isolating host `/tmp`** — `/tmp` is deliberately shared read/write for
  compatibility with host tools and the in-process file tools. Files and IPC
  endpoints placed there are trusted host resources and are an accepted risk.
- **TLS interception or IP/packet-level network filtering** — the egress
  proxy filters on CONNECT target host only and never terminates TLS.
  Clients that ignore proxy environment variables (raw sockets, SSH) are
  simply cut off by the unshared network namespace; making them work is out
  of scope — escalation (`network: true`) is the remedy.
- **macOS support** — bubblewrap is Linux-only; v1 targets Linux including
  WSL2. The backend seam is where macOS support would land later.
- **Sandboxing user-typed `!` bash commands** — the threat model is
  model-driven execution; commands the user types are trusted.
- **Building the Docker backend in v1** — it is specified here as the
  contingency (see Design) but only implemented if bubblewrap is abandoned
  or a host requires it.
- **Replacing pi's permission rules** — regex rules in `settings.json`
  continue to run independently; this extension adds an enforcement layer
  below them, it does not read or modify them.

## Background & constraints

- Pi (v0.82.x) extensions are TypeScript modules loaded in-process, receiving
  an `ExtensionAPI` with `registerTool()` (which can override built-in tools),
  `registerCommand()`, `registerFlag()`, and lifecycle events
  (`session_start`, `session_shutdown`, `user_bash`). Verified against the
  pi-mono example sandbox extension and the user's own pi-tools extension.
- Prior art: the pi-mono `examples/extensions/sandbox` wraps only `bash` via
  `@anthropic-ai/sandbox-runtime`; `igor-makarov/pi-sandbox` wraps
  `bash`/`read`/`write`/`edit` and adds an `unsandboxed: true` escalation
  param with user approval plus an `unsandboxedCommands` allowlist (exact and
  `prefix *` matching, refusing to match commands containing shell
  operators). This spec adopts the second model without the srt dependency.
- Project-local configuration in pi is trust-gated: `ctx.isProjectTrusted()`
  guards loading anything from the repo (pattern verified in pi-tools'
  `tool-tiers.ts`). A sandbox extension MUST honor this — otherwise a
  malicious repo could ship a `.pi/` config that allowlists itself out of
  the sandbox.
- bubblewrap requires unprivileged user namespaces. The primary target host
  is WSL2 (kernel 5.15.x), where user namespaces are available; bwrap is not
  currently installed there (`sudo apt install bubblewrap`). Docker 28.x is
  installed and working — hence Docker as the fallback backend.
- bwrap composes mount and process namespaces from flags (`--ro-bind`,
  `--bind`, path masks, `--unshare-pid`, `--unshare-net`,
  `--die-with-parent`). The usable host toolchain is preserved by mounting
  `/` read-only, then adding writable binds and applying deny masks last.
  Missing writable bind sources are hard errors and must be checked; deny
  rules remain effective even when their target does not exist at session
  start.
- A read-only root still exposes host Unix sockets. Network namespaces do not
  isolate `AF_UNIX`, so privilege-granting runtime sockets such as Docker's
  must be masked explicitly. Host `/tmp` sockets are deliberately exempt per
  the accepted compatibility tradeoff above.
- An unshared network namespace contains only loopback; the only way to
  offer selective egress is to bind a host unix socket into the namespace
  and bridge it to a loopback TCP port inside (srt does exactly this, which
  is why it requires `socat` on Linux). Domain filtering therefore happens
  in a host-side HTTP CONNECT proxy, and only proxy-aware clients (curl,
  git-over-HTTPS, npm, pip — anything honoring `HTTP(S)_PROXY`) can reach
  the network from inside the sandbox.
- The pi process's own HTTPS traffic (LLM API calls, pi-mtls client certs)
  never passes through the sandbox; nothing here may interfere with it.

## Requirements

Numbered and stable — reference them as FR-1/NFR-1 elsewhere; mark dropped
ones "(dropped)" rather than renumbering.

### Functional

- **FR-1**: Every model-driven `bash` invocation that is not explicitly
  escalated or disabled MUST execute inside a bubblewrap sandbox composed
  from the effective policy. The sandbox MUST use a separate PID namespace,
  and all descendants MUST be terminated when the tool call completes,
  aborts, or times out.
- **FR-2**: All Pi v0.82.x built-in tools (`bash`, `read`, `write`, `edit`,
  `grep`, `find`, and `ls`) MUST observe the same filesystem policy.
  `denyRead` paths are hidden from reads and host writes; `denyWrite` paths
  remain readable but reject host writes; all other writes outside
  `allowWrite` are rejected. `read`, `write`, and `edit` enforce this through
  policy-aware operations after canonical path resolution. `grep`, `find`,
  and `ls` MUST execute against the backend's sandboxed filesystem view so
  recursive traversal cannot enter a nested `denyRead` path.
- **FR-3**: The effective policy MUST be loadable from a global config file
  (`~/.pi/agent/bwubblewap.json`) merged with a project-local config
  (`<cwd>/.pi/bwubblewap.json`); the project file MUST be ignored unless the
  project is trusted, and project config MUST only be able to *tighten* the
  effective policy (it may add `denyRead` or `denyWrite` paths; it MUST NOT
  extend `unsandboxedCommands` or the write allowlist beyond the project
  directory).
- **FR-4**: The default policy, with no config files present, MUST deny access
  to at least: `~/.ssh`, `~/.gnupg`, `~/.password-store`, `~/.aws`,
  `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.netrc`,
  `~/.certs`, `~/.pi`, `$XDG_RUNTIME_DIR`, `/run/docker.sock`,
  `/var/run/docker.sock`, and `/run/docker-cli.sock`. Canonically equivalent
  paths MUST be deduplicated. This blocks the common D-Bus/keyring and Docker
  control sockets without hiding accepted host `/tmp` resources.
- **FR-5**: The default policy MUST restrict host writes to the project cwd, a
  per-session scratch directory, and host `/tmp`; everything else is
  read-only or masked by `denyRead`. `/tmp` MUST be bind-mounted from the host
  so bash and in-process built-ins observe the same files.
- **FR-6**: The `bash` tool MUST accept optional `unsandboxed: boolean` and
  `network: boolean` parameters. When a parameter requests more access than
  policy grants, the extension MUST prompt the user for approval before
  executing; denial returns a tool error (not a crash) explaining what was
  refused.
- **FR-7**: A configurable `unsandboxedCommands` list (exact match and
  trailing-`*` prefix match) MUST auto-approve matching escalations without
  prompting. Commands containing shell operators (`&&`, `||`, `|`, `;`,
  newline, `$(`, backtick) MUST never match.
- **FR-8**: At `session_start` the extension MUST probe the backend (bwrap
  present and a trivial command under the effective policy succeeds). On
  probe failure the extension MUST fail closed: every `bash` call is treated
  as an `unsandboxed: true` escalation requiring approval; `grep`, `find`,
  and `ls` return a backend-unavailable tool error; and the policy-aware
  `read`, `write`, and `edit` checks remain active. A visible warning names
  the failure and points at the Docker backend contingency and install
  guidance.
- **FR-9**: A `/sandbox` command MUST show status (active backend, probe
  result, effective policy summary, escalation counts this session) and
  allow disabling/enabling the sandbox for the current session (disable
  requires the same user approval as an escalation).
- **FR-10**: A `--no-sandbox` CLI flag MUST disable the extension for one
  run, with a visible startup notice that sandboxing is off.
- **FR-11**: Sandbox mechanics MUST live behind a backend interface —
  `probe(): ProbeResult` and `wrap(argv, policy): argv` — with the policy
  engine and tool overrides backend-agnostic. Config key `backend` selects
  `"bwrap"` (default) or `"docker"`; selecting `"docker"` in v1 MUST produce
  a clear "not yet implemented, see spec contingency" error rather than
  silently running unsandboxed.
- **FR-12**: Sandboxed commands MUST run with the network namespace
  unshared by default; the only egress is a host-side domain-filtering
  proxy. Policy key `network` accepts `"deny"` (default — proxy with
  `allowedDomains` only), `"allow"` (namespace shared, full network), or
  `"off"` (no namespace sharing and no proxy). The `network: true` tool
  param escalates a single call to full network per FR-6.
- **FR-13**: The proxy MUST admit only CONNECT/absolute-URI targets whose
  host matches `network.allowedDomains` (exact hosts and `*.` wildcard
  patterns), MUST NOT terminate TLS, and MUST default to GitHub and npm:
  `github.com`, `*.github.com`, `*.githubusercontent.com`, `ghcr.io`,
  `registry.npmjs.org`, `*.npmjs.org`. Non-matching requests are refused
  with a response naming the blocked host, and the block is surfaced in the
  tool output so the model can escalate deliberately.
- **FR-14**: Sandboxed commands MUST inherit pi's command environment without
  secret filtering. Under restricted network modes, the extension MUST
  replace `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` with the filtering
  proxy and clear `NO_PROXY`; under other modes it leaves them unchanged.
  Environment variable values MUST never be shown by `/sandbox` or extension
  diagnostics.

### Non-functional

- **NFR-1**: Sandbox wrapping adds ≤ 100 ms latency to a trivial command
  (`true`) on the target WSL2 host, measured against unwrapped execution.
- **NFR-2**: Policy composition never passes policy strings through a shell:
  bwrap is invoked with an argv array; the user command is the only
  shell-interpreted element, exactly as pi's stock bash tool would run it.
- **NFR-3**: Invalid or unparseable config fails closed (sandbox active with
  defaults, escalations always prompt) and reports the config error visibly;
  it never degrades to unsandboxed execution.
- **NFR-4**: The extension never reads or logs the contents of `denyRead`
  paths while enforcing policy; policy paths may appear in diagnostics,
  contents may not. Command output and inherited environment variables are
  model-visible by design and are outside this guarantee.
- **NFR-5**: v1 supports Linux (including WSL2) only and degrades per FR-8
  elsewhere.

## Design

The extension has four parts: a **policy engine**, a **backend** (v1:
bubblewrap), an **egress proxy**, and **tool overrides** wired in via
`pi.registerTool()` for all Pi v0.82.x built-ins: `bash`, `read`, `write`,
`edit`, `grep`, `find`, and `ls`. Extension-provided tools are out of scope.

**Policy engine.** Loads global then project config (project gated on
`ctx.isProjectTrusted()`, and clamped per FR-3), merges over built-in
defaults (FR-4/FR-5), expands `~` and env vars, resolves symlinks, and
deduplicates canonical paths. Missing writable bind sources are rejected or
ignored with a warning as appropriate; deny rules are retained so a path
created later in the session does not become accessible. Produces an
immutable `EffectivePolicy { denyRead[], denyWrite[], allowWrite[], network,
allowedDomains[], backend, unsandboxedCommands[] }` at `session_start`;
`/sandbox` re-reads it on demand. Policy precedence is `denyRead` over
`denyWrite` over `allowWrite` over the default read-only root.

**Egress proxy.** A session-scoped HTTP CONNECT proxy running inside the pi
process, listening on a unix socket in the session scratch directory. It
resolves and dials targets on the host, admitting only hosts matching
`allowedDomains` (FR-13); TLS passes through end-to-end. Under
`network: "deny"`, `wrap()` binds the socket into the namespace and
prefixes the command with a bootstrap that starts a `socat` bridge
(unix socket → `127.0.0.1:<port>`), exports
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`, and clears `NO_PROXY` before
executing the user command. All other environment variables are inherited.
DNS for allowed hosts happens at the proxy on the host, so the namespace
needs no resolver. `socat` presence on the host is part of `probe()`; if
absent, `"deny"` degrades to `"off"` (no egress at all) with a warning —
never to open network.

**Bubblewrap backend.** `wrap(argv, policy)` starts from a read-only host
root, then applies writable binds, read-only overlays, and access masks in
that order:
`["bwrap", "--ro-bind", "/", "/", ...perAllowWrite("--bind", path,
path), ...perDenyWrite("--ro-bind", path, path),
...perDenyRead(maskPath), "--unshare-pid", "--proc", "/proc", "--dev",
"/dev", "--die-with-parent", ...(policy.network === "allow" ? [] :
["--unshare-net", ...proxySocketBind]), "--", ...argv]`. `/tmp` is one of
the writable host binds. For an existing target, `maskPath` creates an
inaccessible empty directory or file/socket placeholder matching its type;
an absent target gets an inaccessible directory placeholder. Regular files
and sockets are not mounted as tmpfs directories. Deny masks are applied last,
so a writable parent such as cwd cannot reveal a nested denied path. The
execution layer kills the sandbox's PID namespace when the initial command
completes, aborts, or times out. `probe()` checks the binary exists and runs
a trivial command with the effective mounts, masks, PID namespace, and
network mode rather than probing only the base root.

**Tool overrides.** The bash override composes: escalation check →
allowlist check → prompt if needed → execute via backend `wrap()` or
directly (approved escalation). `read`, `write`, and `edit` use the built-in
implementations with policy-aware operations: canonicalize the actual target,
reject reads under `denyRead`, and reject writes under `denyRead`, under
`denyWrite`, or outside `allowWrite`. `grep`, `find`, and `ls` use their
built-in result shapes and rendering but route filesystem traversal through
the backend, so nested deny masks are enforced by the namespace rather than
by root-path validation. Rejection is a normal tool error naming the policy
rule, so the model can adapt or escalate.

**Docker backend (contingency — build only if bubblewrap is untenable).**
Same `wrap()`/`probe()` interface. `wrap()` produces `docker run --rm -i
--init --user <uid>:<gid> -v <cwd>:<cwd>:rw -v <scratch>:<scratch>:rw
-v /tmp:/tmp:rw --network <policy.network === "allow" ? "bridge" : "none">
-w <cwd> <image> bash -c <command>`. It passes the host command environment
through without logging values, then applies the same proxy-variable
overrides as bwrap. Key deltas from bwrap, which the policy engine already
absorbs: `denyRead` is implicit for host paths that are not mounted because
the whole host except cwd, scratch, and accepted host `/tmp` is unreadable;
`denyRead` and `denyWrite` paths nested inside those mounts still receive
inaccessible or read-only overlays after the writable mounts, preserving the
same precedence as bwrap. Tool availability comes from the image, not the
host, so config gains
`docker.image` (default: a documented Debian-based dev image) and
`docker.extraMounts` for opting host toolchains in read-only;
`probe()` runs `docker run --rm <image> true`. The egress proxy carries
over unchanged: `--network none` plus the proxy's unix socket mounted into
the container and the same socat bootstrap (socat comes from the image). Known costs: ~300–500 ms
container start per command (NFR-1 explicitly does not apply to this
backend), and commands see the image's toolchain rather than the host's.
Escalation flow, allowlist, file-tool path checks, config, and `/sandbox`
are unchanged — that is the point of the seam.

### Control flow

**Sandboxed bash call (happy path).** Model calls `bash` with `command` →
override finds no escalation params → backend `wrap()` composes bwrap argv
from `EffectivePolicy` (PID and network namespaces unshared, proxy socket
bound in, proxy env exported) → command executes with cwd and host `/tmp`
mounted rw, the remaining host root read-only, secrets and privileged runtime
sockets masked, and the rest of pi's environment inherited → HTTPS to
allowed domains flows through the proxy → output streams back to the model
unchanged → exit code and output are identical in shape to the stock bash
tool.

**Escalated bash call.** Model calls `bash` with `unsandboxed: true` (or
`network: true` under a deny policy) → override checks
`unsandboxedCommands`; on match, executes directly (or with net shared)
with a status-line note → otherwise prompts the user with the command and
requested access → approved: executes with requested access; denied: tool
returns an error string stating the denial.

**Direct file tool call.** Model calls `read`/`write`/`edit` → policy-aware
operation canonicalizes the actual target → path and operation pass policy →
delegate with the canonical target; path fails → tool error naming the
matched rule (e.g. "read denied: ~/.gnupg is a denyRead path").

**Search/list tool call.** Model calls `grep`/`find`/`ls` → override executes
the built-in operation against the backend filesystem view → writable paths
and host `/tmp` remain visible, nested `denyRead` paths stay masked → output
and details retain the stock tool shape.

**Session start.** `session_start` → load + clamp configs → probe backend →
ok: register overrides, status line shows sandbox badge → probe fails:
keep policy-aware direct file checks, make backend-routed read-only tools
return errors, treat bash as an escalation, and warn once (FR-8).

## Edge cases & failure modes

- **Symlink in cwd pointing at a secret** (`ln -s ~/.ssh key`): direct file
  tools canonicalize the actual target before operating → denied. In bwrap,
  the target resolves to the inaccessible mask at `~/.ssh`. No bypass.
- **`python -c`/encoded payloads reading secrets**: kernel-enforced — the
  path is masked in the namespace regardless of command spelling → empty or
  ENOENT.
- **Command backgrounds a process** (`npm run dev &`): the descendant stays
  in the sandbox's PID namespace only until the initial tool command
  completes; the execution layer then kills the namespace. Descendants also
  die on abort, timeout, session shutdown, or pi exit.
- **Deny path doesn't exist on this host** (`~/.azure` absent): the policy
  engine retains the canonical intended path and the backend creates an
  inaccessible placeholder in its namespace. If the host path appears later,
  it does not become visible to sandboxed commands.
- **`$XDG_RUNTIME_DIR` masked breaks D-Bus-needing commands**
  (`secret-tool`, `gnome-keyring` queries): intended behavior; the error the
  model sees is the tool's own failure, escalation is the remedy if the user
  truly wants it.
- **Docker control socket on the read-only root**: masked by default even
  though the socket path itself is not writable. Connecting to it would grant
  host-level filesystem access and bypass the path policy.
- **Host `/tmp` contains files or Unix sockets**: visible and writable by
  design. This compatibility choice, including access to endpoints such as
  X11 or an SSH agent placed there, is an accepted host-trust risk.
- **Pi environment contains credentials**: inherited and therefore readable
  by sandboxed commands. This is an accepted host-trust risk; users must not
  launch pi with long-lived secrets in environment variables.
- **Recursive built-in search starts above a denied path** (`grep` rooted at
  `$HOME` with `~/.ssh` denied): the operation runs in the backend namespace,
  where the nested path is masked; no separate per-file validation is needed.
- **Config file is malformed JSON**: NFR-3 — defaults apply, escalations
  always prompt, warning shown; never silently unsandboxed.
- **Untrusted project ships `.pi/bwubblewap.json`**: ignored entirely
  (FR-3); trusted project config attempting to widen `unsandboxedCommands`
  or allowlist writes outside cwd: those keys are clamped and a warning
  names the ignored entries.
- **bwrap missing or userns disabled** (fresh host, hardened kernel):
  probe fails → fail-closed mode; every bash call prompts; warning explains
  `apt install bubblewrap`, the userns sysctl, and the Docker contingency.
- **Escalation prompt in non-interactive mode** (`pi -p`): no UI to approve
  → escalation is auto-denied with a tool error; allowlisted commands still
  auto-approve.
- **Command hits a non-allowlisted domain** (`curl https://evil.example`):
  proxy refuses the CONNECT naming the host; tool output includes the
  blocked-host message so the model can ask for `network: true` instead of
  retrying blindly.
- **Proxy-ignorant network client** (raw `python -c` sockets, `ssh`,
  `git@github.com:` SSH remotes): unshared namespace has no route — fails
  regardless of target. For GitHub, HTTPS remotes work through the proxy;
  SSH pushes need escalation. Note: the user's own pi package sources use
  SSH URLs, but those are fetched by pi on the host, outside the sandbox.
- **`socat` missing on host**: probe degrades `network: "deny"` to `"off"`
  (no egress at all, warning explains) — never to open network.
- **Proxy dies mid-session**: in-flight and subsequent requests fail
  closed (connection refused inside the namespace); `/sandbox` status
  surfaces the dead proxy.
- **Allowed-domain exfiltration**: a repo-resident secret can still be
  pushed to e.g. a GitHub repo the attacker controls — domain allowlisting
  narrows, it does not eliminate, exfiltration paths. Recorded as accepted
  residual risk; keeping `denyRead` coverage over real secret stores is the
  primary control.
- **Command contains `&&` and matches an allowlist prefix**
  (`git commit * ` vs `git commit -m x && curl ...`): operator check refuses
  the match (FR-7) → falls through to prompt/deny.
- **cwd is under a `denyRead` path** (e.g. running pi inside `~/.pi`):
  policy engine detects the overlap at load, refuses to start the sandbox,
  and fails closed with an explanatory error rather than composing a
  contradictory namespace.
- **WSL2 `/mnt/c` (drvfs) project**: binds work but 9p semantics differ
  (permissions, speed); supported but flagged in `/sandbox` status as a
  degraded-fidelity mount.
- **Pi's own API traffic / pi-mtls**: unaffected by construction — backend
  namespaces wrap only backend-routed tools, and policy checks for direct file
  tools never wrap or restrict the pi process itself.

## Acceptance criteria

- **FR-1/FR-4**: given default policy, when the model runs
  `bash: cat ~/.ssh/id_ed25519` (and the `python -c` equivalent), then the
  command fails to read the file and the output contains no key material;
  attempts to connect to the Docker control socket also fail.
- **FR-1 (process lifetime)**: given a command that backgrounds a long-running
  process, when the initial command completes, then no descendant PID remains
  alive outside the completed tool call.
- **FR-2**: given default policy, when the model calls `read` on
  `~/.gnupg/pubring.kbx` or `write` to `~/.bashrc`, then the tool returns a
  policy error naming the rule and the file is untouched. Given a configured
  `denyWrite` file under cwd, `read` succeeds while `write` and `edit` fail.
- **FR-2 (recursive built-ins)**: given `~/.ssh` is denied, when `grep` or
  `find` starts at `$HOME`, then no contents or entries beneath `~/.ssh`
  appear; `ls ~/.ssh` fails or shows the same inaccessible view as bash.
- **FR-2 (symlink)**: given `ln -s ~/.ssh secret` inside cwd, when the model
  `read`s `./secret/id_ed25519`, then the read is denied.
- **FR-5**: given default policy, when the model writes a file inside cwd
  via `bash`, then it succeeds; when it writes `~/outside.txt`, then it
  fails. A marker written to `/tmp` by bash is visible to the `read` built-in
  and the host, and a host-created `/tmp` marker is visible in the sandbox.
- **FR-3**: given an untrusted project containing `.pi/bwubblewap.json` with
  `unsandboxedCommands: ["*"]`, when a session starts, then the file is
  ignored and `/sandbox` status shows only global+default policy.
- **FR-6**: given a bash call with `unsandboxed: true` not on the allowlist,
  when the user denies the prompt, then the command does not execute and the
  model receives a denial error.
- **FR-7**: given `unsandboxedCommands: ["git push *"]`, when the model runs
  `git push origin main` with `unsandboxed: true`, then it executes without
  a prompt; when it runs `git push origin main && cat ~/.ssh/id_ed25519`,
  then it prompts (or is denied in `-p` mode).
- **FR-8**: given a host with bwrap removed, when a session starts, then a
  warning is shown, a plain `bash: echo hi` call triggers an approval prompt
  instead of running unsandboxed, `grep`/`find`/`ls` return tool errors, and
  direct reads and writes continue to enforce their path policy.
- **FR-9/FR-10**: `/sandbox` displays backend, probe result, and policy
  summary; `pi --no-sandbox` starts with overrides inactive and a notice.
- **FR-11**: given `backend: "docker"` in v1 config, when a session starts,
  then the extension reports the backend as unimplemented and enters
  fail-closed mode (no silent unsandboxed execution).
- **FR-12/FR-13**: given default policy, when the model runs
  `bash: curl https://example.com`, then the request is refused with the
  blocked host named; `curl https://github.com` and
  `npm ping --registry https://registry.npmjs.org` succeed through the
  proxy; `python -c` opening a raw socket to any external IP fails; with
  `network: true` and user approval, `curl https://example.com` succeeds.
- **FR-13 (no TLS interception)**: given a proxied HTTPS request, when the
  client verifies the server certificate, then it sees the origin's real
  certificate chain, not a locally generated one.
- **NFR-1**: median of 20 wrapped `true` runs minus 20 unwrapped runs is
  ≤ 100 ms on the WSL2 host.
- **FR-14**: given a harmless sentinel environment variable in pi's process,
  when sandboxed bash prints it, then the original value is present. Under
  restricted networking, proxy variables name the filtering proxy and
  `NO_PROXY` is empty; `/sandbox` never displays their values.
- **NFR-3**: given `bwubblewap.json` containing invalid JSON, when a session
  starts, then sandboxing is active with defaults and a config warning is
  visible.
- **NFR-4**: policy-denial diagnostics and extension logs may contain the
  matched path but never bytes read from that denied path.

## Open questions

None. Review resolved the main trust-boundary choices: deny-by-default
networking uses a proxy-enforced domain allowlist defaulting to GitHub + npm
(FR-12/FR-13); the host environment and host `/tmp` are trusted and exposed
for usability (FR-5/FR-14); the remaining host root is read-only with named
secret paths and privilege-granting runtime sockets masked; and all seven Pi
v0.82.x built-ins share that policy while extension-provided tools remain out
of scope. The accepted residual risks are recorded in Edge cases.
