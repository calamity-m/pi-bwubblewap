import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, type BashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestApproval } from "../approval.ts";
import { BwrapBackend, redactDiagnostic, runWrapped } from "../backend/bwrap.ts";
import { matchesUnsandboxedCommand } from "../policy/allowlist.ts";
import type { NetworkMode } from "../policy/types.ts";
import type { SessionRuntime } from "../runtime.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function createSandboxedBashDefinition(cwd: string, getRuntime: () => SessionRuntime) {
  const stock = createBashToolDefinition(cwd);
  const parameters = Type.Object(
    {
      ...stock.parameters.properties,
      unsandboxed: Type.Optional(Type.Boolean({ description: "Request host execution" })),
      network: Type.Optional(Type.Boolean({ description: "Request full network for this call" })),
    },
    { additionalProperties: false },
  );
  const backend = new BwrapBackend();
  const createOperations = (network: NetworkMode): BashOperations => ({
    async exec(command, _commandCwd, { onData, signal, timeout, env }) {
      const runtime = getRuntime();
      if (runtime.mode.kind !== "active") {
        throw new Error(`sandbox unavailable: ${runtime.mode.kind}`);
      }
      const { policy, resources } = runtime.mode;
      const call = network === "deny" ? runtime.proxyManager?.registerCall() : undefined;
      if (network === "deny" && (!call || !resources.socatPath || !resources.proxySocket)) {
        throw new Error("selective egress is unavailable; network is off");
      }
      const commandText =
        network === "deny"
          ? `${shellQuote(resources.socatPath!)} TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${shellQuote(resources.proxySocket!)} >/dev/null 2>&1 & __bw_socat=$!; trap 'kill "$__bw_socat" 2>/dev/null' EXIT; sleep 0.01; ${command}`
          : command;
      try {
        const argv = backend.wrap(["/bin/bash", "-c", commandText], policy, resources, {
          network,
          proxyToken: call?.token,
          env,
          signal,
          timeoutSeconds: timeout,
          onData,
        });
        const result = await runWrapped(argv, {
          network,
          env,
          signal,
          timeoutSeconds: timeout,
          onData,
        });
        const blocked = call ? (runtime.proxyManager?.blockedHosts(call.token) ?? []) : [];
        if (blocked.length)
          onData(Buffer.from(`\n[bwubblewap] blocked network targets: ${blocked.join(", ")}\n`));
        return { exitCode: result.exitCode };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "aborted" || message.startsWith("timeout:")) throw error;
        throw new Error(redactDiagnostic(message, policy, resources));
      } finally {
        if (call) runtime.proxyManager?.revokeCall(call.token);
      }
    },
  });
  return {
    ...stock,
    parameters,
    async execute(
      toolCallId: string,
      params: { command: string; timeout?: number; unsandboxed?: boolean; network?: boolean },
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof stock.execute>[3],
      ctx: ExtensionToolContext,
    ) {
      const runtime = getRuntime();
      if (
        runtime.mode.kind === "disabled-by-flag" ||
        runtime.mode.kind === "disabled-for-session"
      ) {
        return stock.execute(toolCallId, params as never, signal, onUpdate, ctx);
      }
      const unavailable = runtime.mode.kind !== "active";
      const wantsUnsandboxed = unavailable || params.unsandboxed === true;
      const wantsNetwork = params.network === true && !unavailable;
      const escalationPolicy =
        runtime.mode.kind === "active" || runtime.mode.kind === "unavailable"
          ? runtime.mode.policy
          : undefined;
      const autoApproved = Boolean(
        escalationPolicy?.configValid &&
        matchesUnsandboxedCommand(params.command, escalationPolicy.unsandboxedCommands),
      );
      const needsApproval =
        wantsUnsandboxed ||
        (wantsNetwork && runtime.mode.kind === "active" && runtime.mode.policy.network !== "allow");
      let approved = !needsApproval;
      if (needsApproval && autoApproved) {
        getRuntime().counters.autoApproved++;
        approved = true;
      } else if (needsApproval) {
        getRuntime().counters.prompted++;
        approved = await requestApproval(
          ctx,
          wantsUnsandboxed ? "unsandboxed host execution" : "full network access",
          params.command,
        );
        if (approved) getRuntime().counters.approved++;
        else getRuntime().counters.denied++;
      }
      if (!approved) throw new Error("sandbox escalation denied; command was not executed");
      if (wantsUnsandboxed)
        return stock.execute(toolCallId, params as never, signal, onUpdate, ctx);
      if (wantsNetwork) {
        const networked = createBashToolDefinition(cwd, { operations: createOperations("allow") });
        return networked.execute(toolCallId, params as never, signal, onUpdate, ctx);
      }
      if (runtime.mode.kind !== "active") throw new Error("sandbox unavailable");
      const sandboxed = createBashToolDefinition(cwd, {
        operations: createOperations(runtime.mode.policy.network),
      });
      return sandboxed.execute(toolCallId, params as never, signal, onUpdate, ctx);
    },
  } as never;
}
