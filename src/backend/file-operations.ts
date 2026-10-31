import type {
  EditOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { SessionRuntime } from "../runtime.ts";
import { BwrapBackend, redactDiagnostic, runWrapped } from "./bwrap.ts";
import { helperArgv } from "./node-runtime.ts";

function activeRuntime(
  getRuntime: () => SessionRuntime,
): Extract<SessionRuntime["mode"], { kind: "active" }> {
  const mode = getRuntime().mode;
  if (mode.kind !== "active") throw new Error(`sandbox unavailable: ${mode.kind}`);
  return mode;
}

async function helper(
  getRuntime: () => SessionRuntime,
  action: string,
  path: string,
  stdin?: string | Buffer,
): Promise<Buffer> {
  const { resources, policy } = activeRuntime(getRuntime);
  const backend = new BwrapBackend();
  const invocation = { network: "off" as const, stdin };
  const result = await runWrapped(
    backend.wrap(helperArgv(resources, action, path), policy, resources, invocation),
    invocation,
  );
  if (result.exitCode !== 0) {
    const message = result.stderr.toString().trim() || `helper ${action} failed`;
    throw new Error(redactDiagnostic(message, policy, resources));
  }
  return result.stdout;
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 6).toString() === "GIF87a" || bytes.subarray(0, 6).toString() === "GIF89a")
    return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  if (bytes.subarray(0, 2).toString() === "BM") return "image/bmp";
  return null;
}

export function createReadOperations(getRuntime: () => SessionRuntime): ReadOperations {
  let cachedPath: string | undefined;
  let cached: Buffer | undefined;
  const read = async (path: string) => {
    if (cachedPath === path && cached) return cached;
    cachedPath = path;
    cached = await helper(getRuntime, "read-r", path);
    return cached;
  };
  return {
    access: async (path) => {
      await read(path);
    },
    readFile: read,
    detectImageMimeType: async (path) => imageMime(await read(path)),
  };
}

export function createEditOperations(getRuntime: () => SessionRuntime): EditOperations {
  let cachedPath: string | undefined;
  let cached: Buffer | undefined;
  const read = async (path: string) => {
    if (cachedPath === path && cached) return cached;
    cachedPath = path;
    cached = await helper(getRuntime, "read-rw", path);
    return cached;
  };
  return {
    access: async (path) => {
      await read(path);
    },
    readFile: read,
    writeFile: async (path, content) => {
      await helper(getRuntime, "write", path, content);
    },
  };
}

export function createWriteOperations(getRuntime: () => SessionRuntime): WriteOperations {
  return {
    mkdir: async (path) => {
      await helper(getRuntime, "mkdir", path);
    },
    writeFile: async (path, content) => {
      await helper(getRuntime, "write", path, content);
    },
  };
}

export function createLsOperations(getRuntime: () => SessionRuntime): LsOperations {
  const statCache = new Map<string, { isDirectory: () => boolean }>();
  return {
    exists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    stat,
    readdir: async (path) => {
      const entries = JSON.parse((await helper(getRuntime, "list", path)).toString()) as Array<{
        name: string;
        isDirectory: boolean;
      }>;
      for (const entry of entries) {
        statCache.set(`${path}/${entry.name}`, { isDirectory: () => entry.isDirectory });
      }
      return entries.map((entry) => entry.name);
    },
  };

  async function stat(path: string): Promise<{ isDirectory: () => boolean }> {
    const cached = statCache.get(path);
    if (cached) return cached;
    const result = JSON.parse((await helper(getRuntime, "stat", path)).toString()) as {
      isDirectory: boolean;
    };
    const value = { isDirectory: () => result.isDirectory };
    statCache.set(path, value);
    return value;
  }
}
