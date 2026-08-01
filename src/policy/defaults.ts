import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { BackendName, NetworkMode } from "./types.ts";

export const DEFAULT_DENY_READ = [
  "~/.ssh",
  "~/.gnupg",
  "~/.password-store",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.kube",
  "~/.docker",
  "~/.netrc",
  "~/.certs",
  getAgentDir(),
  join(homedir(), ".pi", "proxy-audit"),
  "$XDG_RUNTIME_DIR",
  "/run/docker.sock",
  "/var/run/docker.sock",
  "/run/docker-cli.sock",
  "/mnt/wslg/distro",
  "/mnt/wslg/run",
  "/mnt/wsl/docker-desktop",
  "/mnt/wsl/docker-desktop-bind-mounts",
];

export const DEFAULT_DENY_WRITE: readonly string[] = [];
export const DEFAULT_ALLOW_WRITE: readonly string[] = [];
export const DEFAULT_NETWORK: NetworkMode = "deny";
export const DEFAULT_ALLOWED_DOMAINS = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "ghcr.io",
  "registry.npmjs.org",
  "*.npmjs.org",
];
export const DEFAULT_ALLOWED_PORTS = [80, 443];
export const DEFAULT_UNSANDBOXED_COMMANDS: readonly string[] = [];
export const DEFAULT_BACKEND: BackendName = "bwrap";

export function defaultWritePaths(cwd: string, scratchDir: string): string[] {
  return [cwd, scratchDir, join(tmpdir())];
}
