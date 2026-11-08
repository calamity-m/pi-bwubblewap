# pi-bwubblewap

A Linux-only Pi extension that routes Pi 1.5.0 built-in tools through a
bubblewrap sandbox. The sandbox gives model-driven tools a read-only host root,
explicit writable paths, masked credential stores, a separate PID namespace,
and deny-by-default network access.

## Features

- Governs `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`.
- Preserves Pi's stock file-tool schemas, result shapes, mutation queue, and
  renderers while replacing low-level operations.
- Masks common SSH, cloud, Kubernetes, Docker, certificate, Pi-agent, keyring,
  and WSL/Docker alias paths.
- Allows writes only in the project, session scratch directory, and host `/tmp`.
- Uses an authenticated per-call filtering proxy for selective HTTP/HTTPS.
- Supports approved host execution and full-network escalation. Approval dialogs
  keep Deny/Allow once visible while large commands are paged with PgUp/PgDn or
  Home/End; Up/Down changes the selection and Enter confirms (Escape denies).
- Fails closed when initialization, ownership, or backend probing fails.

## Requirements

- Linux, including WSL2
- Node.js 22.19 or newer
- Pi 1.5.0
- `bubblewrap`, `socat`, `ripgrep`, and `fd`

Install these tools with your distribution's package manager (package names vary;
`fd` may be packaged as `fd-find` and invoked as `fdfind`). Ensure the executables
are on the PATH inherited by Pi.

Standalone Pi also needs a separate Node.js runtime: its compiled executable is
not Node. The extension validates a Node host executable or resolves `node` /
`nodejs` from PATH and uses that runtime for every filesystem helper. If Node is
missing, install it using your distribution's package manager or a Node version
manager, then restart Pi. Node and its libraries must be readable under the sandbox
policy; credential stores such as `~/.pi` remain masked.

If bubblewrap is installed but cannot launch, inspect the reported subprocess
stderr and the host's unprivileged user namespace, container, and AppArmor
restrictions rather than reinstalling packages. Probe failures keep tools disabled.

## Install

```bash
pi install git:git@github.com:calamity-m/pi-bwubblewap
```

Use `--tools read,bash,edit,write,grep,find,ls` to activate all seven tools.
The extension does not force-enable normally inactive `grep`, `find`, or `ls`.

## Commands

- `/sandbox` or `/sandbox status` — show backend, policy, ownership, proxy,
  binary, filesystem, warning, and escalation status.
- `/sandbox disable` — disable all seven wrappers for the session after approval.
- `/sandbox enable` — restore the previously active sandbox.
- `/sandbox reload` — reload Pi resources and rebuild the sandbox.
- `--no-sandbox` — visibly delegate all seven tools to Pi for one run.

The `bash` schema adds `unsandboxed: true` and `network: true`. Requests that
widen access prompt in TUI/RPC mode and are denied in print/JSON mode unless a
safe command allowlist entry applies.

## Configuration

Global configuration:

```text
~/.pi/agent/bwubblewap.json
```

Trusted project configuration:

```text
<project>/.pi/extensions/bwubblewap.json
```

The project location deliberately participates in Pi's project-trust flow.
Untrusted project configuration is not read. Relative global paths resolve
against the global config directory; relative project paths resolve against the
project cwd. `~`, `$VAR`, and `${VAR}` are expanded without printing expansion
values in diagnostics.

```json
{
  "backend": "bwrap",
  "denyRead": ["~/.ssh", "./private"],
  "denyWrite": ["./generated.lock"],
  "allowWrite": ["./output"],
  "unsandboxedCommands": ["git status", "git push *"],
  "network": {
    "mode": "deny",
    "allowedDomains": ["github.com", "*.github.com"],
    "allowedPorts": [80, 443]
  }
}
```

Configuration is strict: unknown keys, malformed values, unset variables, and
missing custom paths invalidate that layer. A malformed global layer falls back
to defaults with no auto-approval. A malformed project layer preserves the
valid global/default policy. Project config may add deny rules and cwd-local
write paths; project `backend`, `network`, and `unsandboxedCommands` are ignored.

Default allowed domains are GitHub, GitHub subdomains/content, GHCR, and npm.
Default allowed ports are 80 and 443. Command auto-approval supports exact and
one trailing `*` prefix match. It never matches commands containing shell
operators, substitutions, redirections, newlines, or backgrounding.

## Security boundary

Only model-driven built-in tool calls are sandboxed. Pi itself and installed
extensions remain host processes, so host extensions such as pi-mtls continue
to work. User-entered `!` and `!!` commands and extension-provided model tools
are trusted and outside this boundary.

Filesystem enforcement occurs at the operation itself inside bubblewrap, not
only in a host-side path check. This prevents a checked project path from being
swapped to a denied symlink before an open. Deny-read masks are applied after
writable binds. The host root and deny-write paths are read-only.

Selective networking uses an authenticated call token, a session Unix socket,
and a per-call `socat` loopback bridge. The proxy permits CONNECT and absolute
HTTP targets by hostname and port without terminating TLS. Raw sockets remain
cut off by the network namespace. Pi's own API traffic and pi-mtls traffic do
not pass through this proxy.

## Known limits

- **WSL interop is a known escape.** With host interop enabled, sandboxed bash
  may invoke `cmd.exe` or `wsl.exe` to leave Linux namespaces. Containment of
  that route is explicitly deferred. Future command permissions may be a
  guardrail, but v1 does not claim full WSL2 containment.
- Deny rules enumerate known secret stores and aliases. Add custom credential
  locations; hard links and unknown alternate mounts are not automatically
  discovered.
- Host `/tmp`, including files and Unix sockets, is shared and trusted.
- Sandboxed commands inherit Pi's environment. Do not launch Pi with long-lived
  secrets in environment variables.
- Allowed-domain egress narrows access but cannot prevent uploading project data
  to an attacker-controlled endpoint on an allowed service.
- Sandboxed bash uses `/bin/bash -c`; it cannot honor Pi's unexported
  `shellPath` or `shellCommandPrefix`. Approved host execution uses stock Pi and
  does honor them.
- SOCKS, TLS interception, private-address filtering, corporate upstream proxy
  chaining, macOS, and a Docker backend are out of scope. Selecting `docker`
  fails closed with a contingency message.
- Missing built-in home deny targets may be created as empty mode-0700
  directories or a mode-0600 `~/.netrc` so bubblewrap has durable mountpoints.
- Helper/search input and output use 64 MiB limits; helper stderr uses 64 KiB.

These limits cover implementation decisions D-1 through D-13: Pi 1.5.0,
backend-backed operations, trusted project config path, deferred WSL interop,
narrow Pi-agent masking, known WSL/Docker aliases, allowed ports, expanded
operator rejection, fixed sandbox shell, no SOCKS, no force-activation, explicit
Docker rejection, and bounded helper/search buffering.

## Troubleshooting

- **`bubblewrap is not installed`** — install the packages above and verify
  `bwrap --version`.
- **user namespace failure** — ensure unprivileged user namespaces are enabled.
- **network is off** — verify `socat` is installed and `/sandbox` reports a
  healthy proxy. Failures degrade to no network, never open network.
- **tool ownership error** — another earlier extension owns that built-in.
  Load bwubblewap earlier, commonly with `-e` while diagnosing.
- **missing rg/fd** — only the corresponding search tool is unavailable.

## Development

```bash
npm install --min-release-age=0
npm run typecheck
npm test
npm run test:integration
npm run lint
npm run format:check
npm run pack:dry-run
node scripts/bench.mjs
```

## License

MIT © 2026 calamity-m
