import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestApproval } from "./approval.ts";
import { BwrapBackend, killTrackedProcesses, probeSelectiveNetwork } from "./backend/bwrap.ts";
import { cleanupSessionResources, createSessionResources } from "./backend/resources.ts";
import { buildEffectivePolicy } from "./policy/config.ts";
import { freezeEffectivePolicy } from "./policy/default-policy.ts";
import { ProxyManager } from "./proxy/server.ts";
import { createSessionRuntime, type SessionResources } from "./runtime.ts";
import { join } from "node:path";
import { renderStatus } from "./status.ts";
import { builtinNames, registerBuiltinOverrides } from "./tools/index.ts";

function warn(
  ctx: { hasUI: boolean; ui: { notify(message: string, level: "warning"): void } },
  message: string,
): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else process.stderr.write(`[pi-bwubblewap] ${message}\n`);
}

export default function register(pi: ExtensionAPI): void {
  const runtime = createSessionRuntime();
  let resources: SessionResources | undefined;
  const ownership = registerBuiltinOverrides(pi, process.cwd(), () => runtime);

  pi.on("tool_call", async (event) => {
    if (runtime.mode.kind === "disabled-by-flag" || runtime.mode.kind === "disabled-for-session")
      return;
    if (!builtinNames().includes(event.toolName as never)) return;
    const retained = pi.getAllTools().find((tool) => tool.name === event.toolName);
    const expected = ownership.get(event.toolName as never);
    if (!retained || retained.parameters !== expected) {
      return {
        block: true,
        reason: `pi-bwubblewap does not own active ${event.toolName}; refusing a fail-open tool call`,
      };
    }
  });

  pi.registerFlag("no-sandbox", {
    description: "Disable pi-bwubblewap for this run",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("sandbox", {
    description: "Show or control pi-bwubblewap",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "disable") {
        if (runtime.mode.kind !== "active") {
          ctx.ui.notify(`Sandbox cannot be disabled from ${runtime.mode.kind}`, "warning");
          return;
        }
        runtime.counters.prompted++;
        if (!(await requestApproval(ctx, "disable sandboxing", "/sandbox disable"))) {
          runtime.counters.denied++;
          ctx.ui.notify("Sandbox disable denied", "warning");
          return;
        }
        runtime.counters.approved++;
        runtime.mode = { kind: "disabled-for-session", previous: runtime.mode };
        ctx.ui.setStatus("bwubblewap", "Sandbox: disabled for session");
        return;
      }
      if (command === "enable") {
        if (runtime.mode.kind !== "disabled-for-session") {
          ctx.ui.notify(`Sandbox cannot be enabled from ${runtime.mode.kind}`, "warning");
          return;
        }
        runtime.mode = runtime.mode.previous;
        ctx.ui.setStatus("bwubblewap", "Sandbox: active");
        return;
      }
      if (command === "reload") {
        runtime.mode = { kind: "starting" };
        killTrackedProcesses();
        await runtime.proxyManager?.close();
        runtime.proxyManager = undefined;
        await ctx.reload();
        return;
      }
      if (command !== "" && command !== "status") {
        ctx.ui.notify("Usage: /sandbox status | disable | enable | reload", "warning");
        return;
      }
      ctx.ui.notify(renderStatus(runtime, pi.getAllTools(), ownership), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    runtime.counters = { prompted: 0, approved: 0, autoApproved: 0, denied: 0 };
    if (pi.getFlag("no-sandbox")) {
      runtime.mode = { kind: "disabled-by-flag" };
      warn(ctx, "sandbox disabled via --no-sandbox");
      return;
    }

    runtime.mode = { kind: "starting" };
    if (process.platform !== "linux") {
      runtime.mode = { kind: "unavailable", reason: "pi-bwubblewap v1 supports Linux only" };
      warn(ctx, "sandbox unavailable: pi-bwubblewap v1 supports Linux only");
      return;
    }
    try {
      resources = await createSessionResources();
      const policy = await buildEffectivePolicy(
        { cwd: ctx.cwd, isProjectTrusted: () => ctx.isProjectTrusted() },
        resources,
      );
      if (policy.backend === "docker")
        throw new Error(
          "Docker backend is not yet implemented; see the sandbox contingency in the spec",
        );
      let effectivePolicy = policy;
      const networkOff = (reason: string) =>
        freezeEffectivePolicy({
          ...policy,
          network: "off",
          warnings: [...policy.warnings, `${reason}; network is off`],
        });
      if (policy.network === "deny") {
        resources.proxySocket = join(resources.sessionDir, "proxy.sock");
        if (!resources.socatPath) {
          effectivePolicy = networkOff(
            "socat is unavailable; install socat with your distribution's package manager, ensure it is on Pi's PATH, and restart Pi",
          );
        } else {
          const proxyManager = new ProxyManager({
            socketPath: resources.proxySocket,
            allowedDomains: policy.allowedDomains,
            allowedPorts: policy.allowedPorts,
          });
          try {
            await proxyManager.start();
            runtime.proxyManager = proxyManager;
          } catch (error) {
            await proxyManager.close().catch(() => undefined);
            effectivePolicy = networkOff(
              `selective proxy failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      const backend = new BwrapBackend();
      let probe = await backend.probe(effectivePolicy, resources);
      if (probe.ok && effectivePolicy.network === "deny" && runtime.proxyManager) {
        const selectiveProbe = await probeSelectiveNetwork(
          backend,
          effectivePolicy,
          resources,
          runtime.proxyManager,
        );
        if (selectiveProbe.ok) {
          probe = selectiveProbe;
        } else {
          await runtime.proxyManager.close();
          runtime.proxyManager = undefined;
          effectivePolicy = networkOff(selectiveProbe.reason ?? "selective proxy probe failed");
          probe = await backend.probe(effectivePolicy, resources);
        }
      }
      if (!probe.ok) {
        runtime.mode = {
          kind: "unavailable",
          reason: probe.reason ?? "bubblewrap probe failed",
          policy: effectivePolicy,
          resources,
        };
        warn(
          ctx,
          `sandbox unavailable: ${probe.reason ?? "bubblewrap probe failed; inspect the sandbox configuration and host restrictions"}`,
        );
        return;
      }
      runtime.mode = { kind: "active", policy: effectivePolicy, resources, probe };
      for (const warning of effectivePolicy.warnings) warn(ctx, warning);
      ctx.ui.setStatus("bwubblewap", `Sandbox: bwrap (network ${effectivePolicy.network})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      runtime.mode = { kind: "unavailable", reason, resources };
      warn(ctx, `sandbox initialization failed: ${reason}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    runtime.mode = { kind: "starting" };
    killTrackedProcesses();
    await runtime.proxyManager?.close();
    runtime.proxyManager = undefined;
    await cleanupSessionResources(resources);
    resources = undefined;
    ctx.ui.setStatus("bwubblewap", undefined);
  });
}
