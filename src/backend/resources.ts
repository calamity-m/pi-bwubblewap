import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionResources } from "../runtime.ts";

function resolveCommand(names: readonly string[]): string | undefined {
  for (const name of names) {
    try {
      return execFileSync("which", [name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // Continue to the fallback name.
    }
  }
  return undefined;
}

export async function createSessionResources(): Promise<SessionResources> {
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-bwubblewap-"));
  await chmod(sessionDir, 0o700);
  const scratchDir = join(sessionDir, "scratch");
  const runtimeDir = join(sessionDir, "runtime");
  const masksDir = join(runtimeDir, "masks");
  const binDir = join(runtimeDir, "bin");
  await mkdir(scratchDir, { mode: 0o700 });
  await mkdir(runtimeDir, { mode: 0o700 });
  await mkdir(masksDir, { mode: 0o700 });
  await mkdir(binDir, { mode: 0o700 });

  const helperPath = join(runtimeDir, "fs-helper.mjs");
  await copyFile(new URL("./fs-helper.mjs", import.meta.url), helperPath);
  await chmod(helperPath, 0o555);
  const emptyDir = join(masksDir, "empty-dir");
  const emptyFile = join(masksDir, "empty-file");
  await mkdir(emptyDir, { mode: 0o000 });
  await writeEmptyFile(emptyFile);
  await chmod(emptyFile, 0o000);

  const resources: SessionResources = {
    sessionDir,
    scratchDir,
    runtimeDir,
    helperPath,
    emptyDir,
    emptyFile,
    bwrapPath: resolveCommand(["bwrap"]),
    rgPath: resolveCommand(["rg"]),
    fdPath: resolveCommand(["fd", "fdfind"]),
    socatPath: resolveCommand(["socat"]),
  };
  for (const [source, name] of [
    [resources.rgPath, "rg"],
    [resources.fdPath, "fd"],
  ] as const) {
    if (!source) continue;
    const destination = join(binDir, name);
    await copyFile(source, destination);
    await chmod(destination, 0o555);
    if (name === "rg") resources.rgPath = destination;
    else resources.fdPath = destination;
  }
  return resources;
}

async function writeEmptyFile(path: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, "", { flag: "wx", mode: 0o000 });
}

export async function cleanupSessionResources(
  resources: Pick<SessionResources, "sessionDir"> | undefined,
): Promise<void> {
  if (!resources) return;
  await rm(resources.sessionDir, { recursive: true, force: true });
}

export function resourcePath(resources: SessionResources, name: string): string {
  return join(dirname(resources.runtimeDir), name);
}
