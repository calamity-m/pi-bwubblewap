import { relative, basename } from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  type FindOperations,
} from "@earendil-works/pi-coding-agent";
import { BwrapBackend, redactDiagnostic, runWrapped } from "../backend/bwrap.ts";
import { createLsOperations, createReadOperations } from "../backend/file-operations.ts";
import type { SessionRuntime } from "../runtime.ts";

function displayPath(root: string, filePath: string, directory: boolean): string {
  return directory ? relative(root, filePath).replaceAll("\\", "/") : basename(filePath);
}

export function createSandboxedFindDefinition(cwd: string, getRuntime: () => SessionRuntime) {
  const stock = createFindToolDefinition(cwd);
  const operations: FindOperations = {
    exists: (path) => createLsOperations(getRuntime).exists(path),
    async glob(pattern, searchPath, options) {
      const runtime = getRuntime();
      if (runtime.mode.kind !== "active")
        throw new Error(`sandbox unavailable: ${runtime.mode.kind}`);
      if (!runtime.mode.resources.fdPath) throw new Error("fd is unavailable inside the sandbox");
      const args = [
        runtime.mode.resources.fdPath,
        "--glob",
        "--color=never",
        "--hidden",
        "--no-require-git",
        "--exclude",
        "node_modules",
        "--exclude",
        ".git",
        "--max-results",
        String(options.limit),
      ];
      let effectivePattern = pattern;
      if (pattern.includes("/")) {
        args.push("--full-path");
        if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**")
          effectivePattern = `**/${pattern}`;
      }
      args.push("--", effectivePattern, searchPath);
      const backend = new BwrapBackend();
      const result = await runWrapped(
        backend.wrap(args, runtime.mode.policy, runtime.mode.resources, { network: "off" }),
        { network: "off" },
      );
      if (result.exitCode !== 0 && result.stdout.byteLength === 0)
        throw new Error(
          redactDiagnostic(
            result.stderr.toString().trim() || `fd exited with code ${result.exitCode}`,
            runtime.mode.policy,
            runtime.mode.resources,
          ),
        );
      return result.stdout
        .toString()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    },
  };
  const sandboxed = createFindToolDefinition(cwd, { operations });
  return {
    ...stock,
    ...sandboxed,
    async execute(
      id: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) {
      const mode = getRuntime().mode.kind;
      if (mode === "disabled-by-flag" || mode === "disabled-for-session") {
        return stock.execute(id, params as never, signal, onUpdate as never, ctx as never);
      }
      return sandboxed.execute(id, params as never, signal, onUpdate as never, ctx as never);
    },
  } as never;
}

export function createSandboxedGrepDefinition(cwd: string, getRuntime: () => SessionRuntime) {
  const stock = createGrepToolDefinition(cwd);
  return {
    ...stock,
    async execute(
      _id: string,
      params: {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
      },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) {
      const runtime = getRuntime();
      if (
        runtime.mode.kind === "disabled-by-flag" ||
        runtime.mode.kind === "disabled-for-session"
      ) {
        return stock.execute(_id, params as never, signal, onUpdate as never, ctx as never);
      }
      if (runtime.mode.kind !== "active")
        throw new Error(`sandbox unavailable: ${runtime.mode.kind}`);
      if (!runtime.mode.resources.rgPath)
        throw new Error("ripgrep is unavailable inside the sandbox");
      const reads = createReadOperations(getRuntime);
      if (signal?.aborted) throw new Error("Operation aborted");
      const searchPath = params.path
        ? params.path.startsWith("/")
          ? params.path
          : `${cwd}/${params.path}`
        : cwd;
      const rootStat = await (await createLsOperations(getRuntime)).stat(searchPath);
      const isDirectory = rootStat.isDirectory();
      const limit = Math.max(1, params.limit ?? 100);
      const args = [
        runtime.mode.resources.rgPath,
        "--json",
        "--line-number",
        "--color=never",
        "--hidden",
      ];
      if (params.ignoreCase) args.push("--ignore-case");
      if (params.literal) args.push("--fixed-strings");
      if (params.glob) args.push("--glob", params.glob);
      args.push("--", params.pattern, searchPath);
      const backend = new BwrapBackend();
      const result = await runWrapped(
        backend.wrap(args, runtime.mode.policy, runtime.mode.resources, { network: "off", signal }),
        { network: "off", signal },
      );
      if (result.exitCode !== 0 && result.exitCode !== 1 && result.stdout.byteLength === 0)
        throw new Error(
          redactDiagnostic(
            result.stderr.toString().trim() || `ripgrep exited with code ${result.exitCode}`,
            runtime.mode.policy,
            runtime.mode.resources,
          ),
        );
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const raw of result.stdout.toString().split("\n")) {
        if (!raw) continue;
        let event: {
          type?: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        if (
          event.type !== "match" ||
          !event.data?.path?.text ||
          typeof event.data.line_number !== "number"
        )
          continue;
        matches.push({
          path: event.data.path.text,
          line: event.data.line_number,
          text: event.data.lines?.text ?? "",
        });
        if (matches.length >= limit) break;
      }
      if (matches.length === 0)
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };
      const context = params.context && params.context > 0 ? params.context : 0;
      const output: string[] = [];
      for (const match of matches) {
        const name = displayPath(searchPath, match.path, isDirectory);
        if (!context) {
          output.push(`${name}:${match.line}: ${match.text.replace(/\r?\n$/, "")}`);
          continue;
        }
        const lines = (await reads.readFile(match.path))
          .toString()
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .split("\n");
        for (
          let line = Math.max(1, match.line - context);
          line <= Math.min(lines.length, match.line + context);
          line++
        ) {
          output.push(
            `${name}${line === match.line ? ":" : "-"}${line}${line === match.line ? ": " : "- "}${lines[line - 1] ?? ""}`,
          );
        }
      }
      return {
        content: [{ type: "text", text: output.join("\n") }],
        details: matches.length >= limit ? { matchLimitReached: limit } : undefined,
      };
    },
  } as never;
}
