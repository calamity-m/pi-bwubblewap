import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { SessionRuntime } from "./runtime.ts";
import type { BuiltinName } from "./tools/index.ts";

interface ToolInfo {
  name: string;
  parameters: object;
  sourceInfo?: { source?: string; path?: string };
}

export function renderStatus(
  runtime: SessionRuntime,
  tools: readonly ToolInfo[],
  ownership: ReadonlyMap<BuiltinName, object>,
): string {
  const lines = [`Sandbox: ${runtime.mode.kind}`];
  const mode = runtime.mode;
  if (mode.kind === "active") {
    lines.push(`backend: ${mode.policy.backend}`, `probe: ${mode.probe.ok ? "ok" : "failed"}`);
    lines.push(`network: ${mode.policy.network}`);
    lines.push(`allowed domains: ${mode.policy.allowedDomains.join(", ") || "(none)"}`);
    lines.push(`allowed ports: ${mode.policy.allowedPorts.join(", ") || "(none)"}`);
    lines.push(`proxy: ${runtime.proxyManager?.isAlive() ? "healthy" : "inactive"}`);
    lines.push(`proxy active calls: ${runtime.proxyManager?.activeTokenCount() ?? 0}`);
    lines.push(
      `denyRead (${mode.policy.denyRead.length}): ${mode.policy.denyRead.map((rule) => rule.configured).join(", ")}`,
    );
    lines.push(
      `denyWrite (${mode.policy.denyWrite.length}): ${mode.policy.denyWrite.map((rule) => rule.configured).join(", ") || "(none)"}`,
    );
    lines.push(
      `allowWrite (${mode.policy.allowWrite.length}): ${mode.policy.allowWrite.map((rule) => rule.configured).join(", ")}`,
    );
    lines.push(`config valid: ${mode.policy.configValid}`);
    lines.push(`config sources: ${mode.policy.configSources.join(", ") || "defaults only"}`);
    lines.push(`bwrap: ${mode.resources.bwrapPath ? "available" : "missing"}`);
    lines.push(`socat: ${mode.resources.socatPath ? "available" : "missing"}`);
    lines.push(`rg: ${mode.resources.rgPath ? "available" : "missing"}`);
    lines.push(`fd: ${mode.resources.fdPath ? "available" : "missing"}`);
    for (const warning of mode.policy.warnings) lines.push(`warning: ${warning}`);
    try {
      const filesystem = execFileSync("stat", ["-f", "-c", "%T", mode.policy.cwd], {
        encoding: "utf8",
      }).trim();
      lines.push(`cwd filesystem: ${filesystem}`);
      if (["v9fs", "9p", "drvfs"].includes(filesystem))
        lines.push("warning: cwd uses a degraded-fidelity Windows mount");
    } catch {
      lines.push("cwd filesystem: unknown");
    }
  } else if (mode.kind === "unavailable") {
    lines.push(`reason: ${mode.reason}`);
  }
  for (const [name, expected] of ownership) {
    const tool = tools.find((candidate) => candidate.name === name);
    const owned = tool?.parameters === expected;
    lines.push(
      `${name}: ${owned ? "owned" : "OVERRIDDEN BY"} ${tool?.sourceInfo?.source ?? tool?.sourceInfo?.path ?? "unknown"}`,
    );
  }
  lines.push(
    `escalations: ${runtime.counters.prompted} prompted, ${runtime.counters.approved} approved, ${runtime.counters.autoApproved} auto-approved, ${runtime.counters.denied} denied`,
  );
  if (isWsl()) lines.push("WSL interop escape: deferred / not contained (cmd.exe and wsl.exe)");
  return lines.join("\n");
}

function isWsl(): boolean {
  if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) return true;
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}
