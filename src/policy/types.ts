export type NetworkMode = "deny" | "allow" | "off";
export type BackendName = "bwrap" | "docker";

export interface NetworkConfig {
  mode?: NetworkMode;
  allowedDomains?: string[];
  allowedPorts?: number[];
}

export interface BwubblewapConfig {
  backend?: BackendName;
  denyRead?: string[];
  denyWrite?: string[];
  allowWrite?: string[];
  unsandboxedCommands?: string[];
  network?: NetworkConfig;
}

export interface PathRule {
  configured: string;
  path: string;
  kind: "dir" | "file" | "socket";
  materialized: boolean;
}

export interface EffectivePolicy {
  readonly backend: BackendName;
  readonly denyRead: readonly PathRule[];
  readonly denyWrite: readonly PathRule[];
  readonly allowWrite: readonly PathRule[];
  readonly network: NetworkMode;
  readonly allowedDomains: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly unsandboxedCommands: readonly string[];
  readonly cwd: string;
  readonly warnings: readonly string[];
  readonly configSources: readonly string[];
  readonly configValid: boolean;
}

export class PolicyError extends Error {
  override readonly name = "PolicyError";
}
