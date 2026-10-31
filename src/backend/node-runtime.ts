import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, delimiter, isAbsolute, resolve } from "node:path";
import type { SessionResources } from "../runtime.ts";

export const NODE_UNAVAILABLE =
  "No working Node.js runtime found. Install Node.js with your distribution's package manager or a Node version manager, ensure node (or nodejs) is on Pi's PATH, then restart Pi. Standalone Pi cannot run filesystem helpers itself.";

// Do not execute a standalone Pi binary even to test whether it is Node: it may
// start another agent. Only a Node-named host executable is a host candidate.
export function resolveNodeRuntime(
  execPath = process.execPath,
  path = process.env.PATH ?? "",
): string | undefined {
  const candidates = [
    ...(/^(node|nodejs)(\.exe)?$/.test(basename(execPath)) ? [execPath] : []),
    ...path
      .split(delimiter)
      .filter(Boolean)
      .flatMap((dir) => [resolve(dir, "node"), resolve(dir, "nodejs")]),
  ];
  for (const candidate of new Set(candidates)) {
    try {
      const executable = realpathSync(candidate);
      const runtime = validateNode(executable);
      // Version-manager shims can run Node but may need host-only config. Use
      // the actual runtime's path and verify it works without the shim too.
      if (runtime && (runtime === executable || validateNode(runtime) === runtime)) return runtime;
    } catch {
      // Missing, non-Node, or unusable candidate; try the next runtime.
    }
  }
  return undefined;
}

function validateNode(executable: string): string | undefined {
  const output = execFileSync(
    executable,
    [
      "--input-type=module",
      "-e",
      'if (process.release.name === "node" && !process.versions.bun) process.stdout.write(JSON.stringify({node: process.versions.node, execPath: process.execPath}))',
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, maxBuffer: 4096 },
  );
  const result = JSON.parse(output);
  if (
    typeof result.node === "string" &&
    /^\d+\.\d+\.\d+$/.test(result.node) &&
    typeof result.execPath === "string" &&
    isAbsolute(result.execPath)
  )
    return realpathSync(result.execPath);
  return undefined;
}

export function helperArgv(resources: SessionResources, action: string, path: string): string[] {
  if (!resources.nodePath || !isAbsolute(resources.nodePath)) throw new Error(NODE_UNAVAILABLE);
  return [resources.nodePath, resources.helperPath, action, path];
}
