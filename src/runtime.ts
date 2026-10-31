import type { EffectivePolicy } from "./policy/types.ts";
import type { ProxyManager } from "./proxy/server.ts";

export interface ProbeResult {
  ok: boolean;
  reason?: string;
  selectiveNetworkChecked: boolean;
}

export interface SessionResources {
  sessionDir: string;
  scratchDir: string;
  runtimeDir: string;
  helperPath: string;
  emptyDir: string;
  emptyFile: string;
  /** Actual Node executable, validated during session initialization. */
  nodePath?: string;
  bwrapPath?: string;
  rgPath?: string;
  fdPath?: string;
  socatPath?: string;
  proxySocket?: string;
}

export interface EscalationCounters {
  prompted: number;
  approved: number;
  autoApproved: number;
  denied: number;
}

export type RuntimeMode =
  | { kind: "starting" }
  | { kind: "active"; policy: EffectivePolicy; resources: SessionResources; probe: ProbeResult }
  | { kind: "unavailable"; reason: string; policy?: EffectivePolicy; resources?: SessionResources }
  | { kind: "disabled-by-flag" }
  | { kind: "disabled-for-session"; previous: Extract<RuntimeMode, { kind: "active" }> };

export interface SessionRuntime {
  mode: RuntimeMode;
  counters: EscalationCounters;
  proxyManager?: ProxyManager;
}

export function createSessionRuntime(): SessionRuntime {
  return {
    mode: { kind: "starting" },
    counters: { prompted: 0, approved: 0, autoApproved: 0, denied: 0 },
  };
}
