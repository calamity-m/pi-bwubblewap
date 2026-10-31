import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { canonicalizePath, isUnder } from "../policy/paths.ts";
import type { SessionRuntime } from "../runtime.ts";
import {
  createEditOperations,
  createLsOperations,
  createReadOperations,
  createWriteOperations,
} from "../backend/file-operations.ts";

function targetPath(cwd: string, input: string | undefined): string {
  const value = (input ?? ".").trim().replace(/^@/, "");
  return canonicalizePath(value || ".", { baseDir: cwd });
}

function checkRead(runtime: SessionRuntime, path: string, cwd: string): void {
  if (runtime.mode.kind !== "active") return;
  const target = targetPath(cwd, path);
  const rule = runtime.mode.policy.denyRead.find((candidate) => isUnder(target, candidate.path));
  if (rule) throw new Error(`read denied by ${rule.configured}`);
}

function checkWrite(runtime: SessionRuntime, path: string, cwd: string): void {
  if (runtime.mode.kind !== "active") return;
  const target = targetPath(cwd, path);
  const denyRead = runtime.mode.policy.denyRead.find((candidate) =>
    isUnder(target, candidate.path),
  );
  if (denyRead) throw new Error(`write denied by ${denyRead.configured}`);
  const denyWrite = runtime.mode.policy.denyWrite.find((candidate) =>
    isUnder(target, candidate.path),
  );
  if (denyWrite) throw new Error(`write denied by ${denyWrite.configured}`);
  if (!runtime.mode.policy.allowWrite.some((candidate) => isUnder(target, candidate.path))) {
    throw new Error(`write denied outside allowWrite paths`);
  }
}

function delegateIfDisabled(
  runtime: SessionRuntime,
  stock: { execute: Function },
  args: unknown[],
): unknown {
  if (runtime.mode.kind === "disabled-by-flag" || runtime.mode.kind === "disabled-for-session") {
    return stock.execute(...args);
  }
  if (runtime.mode.kind !== "active") throw new Error(`sandbox unavailable: ${runtime.mode.kind}`);
  return undefined;
}

export function createSandboxedFileDefinitions(cwd: string, getRuntime: () => SessionRuntime) {
  const stockRead = createReadToolDefinition(cwd);
  const stockWrite = createWriteToolDefinition(cwd);
  const stockEdit = createEditToolDefinition(cwd);
  const stockLs = createLsToolDefinition(cwd);
  return {
    read: {
      ...stockRead,
      async execute(
        id: string,
        params: { path: string },
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ExtensionToolContext,
      ) {
        const disabled = delegateIfDisabled(getRuntime(), stockRead, [
          id,
          params,
          signal,
          onUpdate,
          ctx,
        ]);
        if (disabled !== undefined) return disabled;
        checkRead(getRuntime(), params.path, ctx.cwd);
        const sandboxed = createReadToolDefinition(cwd, {
          operations: createReadOperations(getRuntime),
        });
        return sandboxed.execute(id, params as never, signal, onUpdate as never, ctx);
      },
    },
    write: {
      ...stockWrite,
      async execute(
        id: string,
        params: { path: string; content: string },
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ExtensionToolContext,
      ) {
        const disabled = delegateIfDisabled(getRuntime(), stockWrite, [
          id,
          params,
          signal,
          onUpdate,
          ctx,
        ]);
        if (disabled !== undefined) return disabled;
        checkWrite(getRuntime(), params.path, ctx.cwd);
        const sandboxed = createWriteToolDefinition(cwd, {
          operations: createWriteOperations(getRuntime),
        });
        return sandboxed.execute(id, params as never, signal, onUpdate as never, ctx);
      },
    },
    edit: {
      ...stockEdit,
      renderCall(args: { path?: string; edits?: unknown[] }) {
        return new Text(
          `${args.path ?? "(unknown path)"} (${args.edits?.length ?? 0} edit(s))`,
          0,
          0,
        );
      },
      async execute(
        id: string,
        params: { path: string; edits: unknown[] },
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ExtensionToolContext,
      ) {
        const disabled = delegateIfDisabled(getRuntime(), stockEdit, [
          id,
          params,
          signal,
          onUpdate,
          ctx,
        ]);
        if (disabled !== undefined) return disabled;
        checkRead(getRuntime(), params.path, ctx.cwd);
        checkWrite(getRuntime(), params.path, ctx.cwd);
        const sandboxed = createEditToolDefinition(cwd, {
          operations: createEditOperations(getRuntime),
        });
        return sandboxed.execute(id, params as never, signal, onUpdate as never, ctx);
      },
    },
    ls: {
      ...stockLs,
      async execute(
        id: string,
        params: { path?: string },
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ExtensionToolContext,
      ) {
        const disabled = delegateIfDisabled(getRuntime(), stockLs, [
          id,
          params,
          signal,
          onUpdate,
          ctx,
        ]);
        if (disabled !== undefined) return disabled;
        checkRead(getRuntime(), params.path ?? ".", ctx.cwd);
        const sandboxed = createLsToolDefinition(cwd, {
          operations: createLsOperations(getRuntime),
        });
        return sandboxed.execute(id, params as never, signal, onUpdate as never, ctx);
      },
    },
  };
}
