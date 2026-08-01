import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSandboxedBashDefinition } from "./bash.ts";
import { createSandboxedFileDefinitions } from "./files.ts";
import { createSandboxedFindDefinition, createSandboxedGrepDefinition } from "./search.ts";
import type { SessionRuntime } from "../runtime.ts";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

const BUILTIN_NAMES = ["bash", "read", "write", "edit", "grep", "find", "ls"] as const;
export type BuiltinName = (typeof BUILTIN_NAMES)[number];

export function builtinNames(): readonly BuiltinName[] {
  return BUILTIN_NAMES;
}

function unavailable(name: string): never {
  throw new Error(`pi-bwubblewap is not initialized; ${name} is fail-closed`);
}

/** Register every built-in at factory time so startup cannot briefly fail open. */
export function registerBuiltinOverrides(
  pi: ExtensionAPI,
  cwd = process.cwd(),
  getRuntime?: () => SessionRuntime,
): Map<BuiltinName, object> {
  const files = getRuntime ? createSandboxedFileDefinitions(cwd, getRuntime) : undefined;
  const definitions = [
    getRuntime ? createSandboxedBashDefinition(cwd, getRuntime) : createBashToolDefinition(cwd),
    files?.read ?? createReadToolDefinition(cwd),
    files?.write ?? createWriteToolDefinition(cwd),
    files?.edit ?? createEditToolDefinition(cwd),
    getRuntime ? createSandboxedGrepDefinition(cwd, getRuntime) : createGrepToolDefinition(cwd),
    getRuntime ? createSandboxedFindDefinition(cwd, getRuntime) : createFindToolDefinition(cwd),
    files?.ls ?? createLsToolDefinition(cwd),
  ];

  const ownership = new Map<BuiltinName, object>();
  for (const definition of definitions) {
    ownership.set(definition.name as BuiltinName, definition.parameters as object);
    pi.registerTool(
      getRuntime
        ? (definition as never)
        : ({
            ...definition,
            async execute() {
              return unavailable(definition.name);
            },
          } as never),
    );
  }
  return ownership;
}
