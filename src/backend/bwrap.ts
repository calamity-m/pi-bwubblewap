import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { constants } from "node:fs";
import { access, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { EffectivePolicy, NetworkMode, PathRule } from "../policy/types.ts";
import type { SessionResources, ProbeResult } from "../runtime.ts";
import type { ProxyManager } from "../proxy/server.ts";

export const MAX_CHILD_STDOUT_BYTES = 64 * 1024 * 1024;
export const MAX_CHILD_STDERR_BYTES = 64 * 1024;
export const MAX_CHILD_STDIN_BYTES = 64 * 1024 * 1024;

export interface InvocationOptions {
  network: NetworkMode;
  proxyToken?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: Buffer | string;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  onData?: (chunk: Buffer) => void;
}

export interface Backend {
  readonly name: "bwrap";
  probe(policy: EffectivePolicy, resources: SessionResources): Promise<ProbeResult>;
  wrap(
    argv: string[],
    policy: EffectivePolicy,
    resources: SessionResources,
    invocation: InvocationOptions,
  ): string[];
}

export interface WrappedResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

const trackedChildren = new Set<ChildProcess>();

export function killTrackedProcesses(): void {
  for (const child of trackedChildren) killGroup(child);
}

const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const;
const NO_PROXY_ENV = ["NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

function existing(rule: PathRule): boolean {
  try {
    const stats = lstatSync(rule.path);
    return !stats.isSymbolicLink() && realpathSync(rule.path) === rule.path;
  } catch {
    return false;
  }
}

function appendMask(args: string[], rule: PathRule, resources: SessionResources): void {
  args.push("--ro-bind", rule.kind === "dir" ? resources.emptyDir : resources.emptyFile, rule.path);
}

export function composeBwrapArgv(
  argv: readonly string[],
  policy: EffectivePolicy,
  resources: SessionResources,
  invocation: InvocationOptions,
): string[] {
  if (!resources.bwrapPath || !isAbsolute(resources.bwrapPath))
    throw new Error("bubblewrap path is unavailable");
  const args = [resources.bwrapPath, "--ro-bind", "/", "/"];
  for (const rule of policy.allowWrite) {
    if (existing(rule)) args.push("--bind", rule.path, rule.path);
  }
  for (const rule of policy.denyWrite) {
    if (existing(rule)) args.push("--ro-bind", rule.path, rule.path);
  }
  for (const rule of policy.denyRead) {
    if (existing(rule)) appendMask(args, rule, resources);
  }
  args.push("--ro-bind", resources.runtimeDir, resources.runtimeDir);
  args.push(
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
  );
  args.push("--chdir", policy.cwd);

  if (invocation.network !== "allow") {
    args.push("--unshare-net");
  }
  if (invocation.network === "off") {
    for (const name of [...PROXY_ENV, ...NO_PROXY_ENV]) args.push("--unsetenv", name);
  } else if (invocation.network === "deny") {
    if (!resources.proxySocket || !invocation.proxyToken) {
      throw new Error("selective network requires a proxy socket and call token");
    }
    args.push("--ro-bind", resources.proxySocket, resources.proxySocket);
    const proxyUrl = `http://bw:${invocation.proxyToken}@127.0.0.1:3128`;
    for (const name of PROXY_ENV) {
      args.push("--setenv", name, proxyUrl);
      args.push("--setenv", name.toLowerCase(), proxyUrl);
    }
    for (const name of ["NO_PROXY", "no_proxy"]) args.push("--unsetenv", name);
  }
  args.push("--", ...argv);
  return args;
}

function killGroup(child: ChildProcess, force = false): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
  if (force) return;
  setTimeout(() => {
    if (!child.pid || !trackedChildren.has(child)) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 100).unref();
}

export async function runWrapped(
  argv: string[],
  invocation: InvocationOptions,
): Promise<WrappedResult> {
  const input = invocation.stdin === undefined ? undefined : Buffer.from(invocation.stdin);
  if (input && input.byteLength > MAX_CHILD_STDIN_BYTES)
    throw new Error(`bwubblewap child input exceeds ${MAX_CHILD_STDIN_BYTES} bytes`);
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    env: invocation.env ?? process.env,
  });
  trackedChildren.add(child);
  child.once("exit", () => killGroup(child, true));
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let streamError: Error | undefined;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const abort = () => killGroup(child);
  if (input) child.stdin?.end(input);
  child.stdout?.on("data", (chunk: Buffer) => {
    if (invocation.onData) {
      invocation.onData(chunk);
      return;
    }
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > MAX_CHILD_STDOUT_BYTES) {
      streamError = new Error(`bwubblewap child stdout exceeds ${MAX_CHILD_STDOUT_BYTES} bytes`);
      killGroup(child);
      return;
    }
    stdout.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (invocation.onData) {
      invocation.onData(chunk);
      return;
    }
    stderrBytes += chunk.byteLength;
    if (stderrBytes > MAX_CHILD_STDERR_BYTES) {
      streamError = new Error(`bwubblewap child stderr exceeds ${MAX_CHILD_STDERR_BYTES} bytes`);
      killGroup(child);
      return;
    }
    stderr.push(chunk);
  });
  if (invocation.signal) {
    if (invocation.signal.aborted) abort();
    else invocation.signal.addEventListener("abort", abort, { once: true });
  }
  if (invocation.timeoutSeconds !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, invocation.timeoutSeconds * 1000);
  }
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (invocation.signal?.aborted) throw new Error("aborted");
    if (timedOut) throw new Error(`timeout:${invocation.timeoutSeconds}`);
    if (streamError) throw streamError;
    return { exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally {
    if (timer) clearTimeout(timer);
    if (invocation.signal) invocation.signal.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) killGroup(child);
    trackedChildren.delete(child);
  }
}

export function redactDiagnostic(
  message: string,
  policy: EffectivePolicy,
  resources?: SessionResources,
): string {
  let result = message;
  for (const rule of [...policy.denyRead, ...policy.denyWrite, ...policy.allowWrite].sort(
    (a, b) => b.path.length - a.path.length,
  )) {
    result = result.split(rule.path).join(rule.configured);
  }
  if (resources) {
    result = result.split(resources.sessionDir).join("{session}");
    result = result.split(resources.runtimeDir).join("{runtime}");
  }
  return result.replace(/bw:[^@\s]+@/g, "bw:{token}@").slice(0, 500);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export async function probeSelectiveNetwork(
  backend: BwrapBackend,
  policy: EffectivePolicy,
  resources: SessionResources,
  proxy: ProxyManager,
): Promise<ProbeResult> {
  if (!resources.socatPath || !resources.proxySocket) {
    return {
      ok: false,
      reason: "socat or proxy socket is unavailable",
      selectiveNetworkChecked: false,
    };
  }
  const call = proxy.registerCall();
  const auth = Buffer.from(`bw:${call.token}`).toString("base64");
  const command = `${shellQuote(resources.socatPath)} TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${shellQuote(resources.proxySocket)} >/dev/null 2>&1 & p=$!; trap 'kill "$p" 2>/dev/null' EXIT; sleep 0.01; exec 3<>/dev/tcp/127.0.0.1/3128; printf 'CONNECT blocked.invalid:443 HTTP/1.1\\r\\nProxy-Authorization: Basic ${auth}\\r\\n\\r\\n' >&3; cat <&3`;
  try {
    const result = await runWrapped(
      backend.wrap(["/bin/bash", "-c", command], policy, resources, {
        network: "deny",
        proxyToken: call.token,
      }),
      { network: "deny" },
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    if (result.exitCode !== 0 || !output.includes("403") || !output.includes("blocked.invalid")) {
      return {
        ok: false,
        reason: "selective network probe did not observe the expected blocked CONNECT",
        selectiveNetworkChecked: false,
      };
    }
    return { ok: true, selectiveNetworkChecked: true };
  } catch (error) {
    return {
      ok: false,
      reason: redactDiagnostic(
        error instanceof Error ? error.message : String(error),
        policy,
        resources,
      ),
      selectiveNetworkChecked: false,
    };
  } finally {
    proxy.revokeCall(call.token);
  }
}

export class BwrapBackend implements Backend {
  readonly name = "bwrap" as const;
  private readonly run: typeof runWrapped;

  constructor(run: typeof runWrapped = runWrapped) {
    this.run = run;
  }

  wrap(
    argv: string[],
    policy: EffectivePolicy,
    resources: SessionResources,
    invocation: InvocationOptions,
  ): string[] {
    return composeBwrapArgv(argv, policy, resources, invocation);
  }

  async probe(policy: EffectivePolicy, resources: SessionResources): Promise<ProbeResult> {
    if (!resources.bwrapPath)
      return { ok: false, reason: "bubblewrap is not installed", selectiveNetworkChecked: false };
    const deniedPath = join(resources.sessionDir, "probe-denied");
    const outsidePath = `/var/tmp/pi-bwubblewap-probe-${process.pid}`;
    const writePath = join(resources.scratchDir, "probe-write");
    const probePolicy: EffectivePolicy = Object.freeze({
      ...policy,
      denyRead: Object.freeze([
        ...policy.denyRead,
        {
          configured: "{probe-denied}",
          path: deniedPath,
          kind: "file" as const,
          materialized: false,
        },
      ]),
    });
    try {
      await writeFile(deniedPath, "pi-bwubblewap probe sentinel");
      const trivial = await this.run(
        this.wrap(["/bin/true"], probePolicy, resources, { network: "off" }),
        { network: "off" },
      );
      if (trivial.exitCode !== 0)
        return {
          ok: false,
          reason: redactDiagnostic(trivial.stderr.toString(), policy, resources),
          selectiveNetworkChecked: false,
        };
      const read = await this.run(
        this.wrap(
          [process.execPath, resources.helperPath, "read-r", deniedPath],
          probePolicy,
          resources,
          { network: "off" },
        ),
        { network: "off" },
      );
      if (read.exitCode === 0 || read.stdout.toString().includes("probe sentinel"))
        return { ok: false, reason: "probe denyRead check failed", selectiveNetworkChecked: false };
      const write = await this.run(
        this.wrap(
          [process.execPath, resources.helperPath, "write", writePath],
          probePolicy,
          resources,
          { network: "off", stdin: "probe" },
        ),
        { network: "off", stdin: "probe" },
      );
      if (write.exitCode !== 0)
        return {
          ok: false,
          reason: "probe scratch write check failed",
          selectiveNetworkChecked: false,
        };
      const outside = await this.run(
        this.wrap(
          [process.execPath, resources.helperPath, "write", outsidePath],
          probePolicy,
          resources,
          { network: "off", stdin: "probe" },
        ),
        { network: "off", stdin: "probe" },
      );
      if (outside.exitCode === 0)
        return {
          ok: false,
          reason: "probe outside-write check failed",
          selectiveNetworkChecked: false,
        };
      await access(policy.cwd, constants.F_OK);
      return { ok: true, selectiveNetworkChecked: false };
    } catch (error) {
      return {
        ok: false,
        reason: redactDiagnostic(
          error instanceof Error ? error.message : String(error),
          policy,
          resources,
        ),
        selectiveNetworkChecked: false,
      };
    } finally {
      await Promise.allSettled([
        rm(deniedPath, { force: true }),
        rm(writePath, { force: true }),
        rm(outsidePath, { force: true }),
      ]);
    }
  }
}
