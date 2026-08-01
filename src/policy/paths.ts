import { realpathSync, statSync } from "node:fs";
import { access, lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { PolicyError, type PathRule } from "./types.ts";

const ENV_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export interface CanonicalPathOptions {
  baseDir?: string;
  defaultKind?: PathRule["kind"];
  home?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface MaterializationOperations {
  mkdir(path: string, options: { mode: number }): Promise<void>;
  openExclusive(path: string, mode: number): Promise<void>;
}

export function expandPath(
  expression: string,
  baseDir = process.cwd(),
  home = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let expanded = expression;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = join(home, expanded.slice(2));
  }
  expanded = expanded.replace(
    ENV_REFERENCE,
    (match, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain;
      if (!name) return match;
      const value = environment[name];
      if (value === undefined) throw new PolicyError(`Environment variable ${name} is not set`);
      return value;
    },
  );
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function classifyExisting(path: string): PathRule["kind"] {
  const stats = statSync(path);
  if (stats.isDirectory()) return "dir";
  if (stats.isSocket()) return "socket";
  return "file";
}

/** Resolve through the longest existing ancestor without requiring the leaf to exist. */
export function canonicalizePath(expression: string, options: CanonicalPathOptions = {}): string {
  const absolute = resolve(
    expandPath(expression, options.baseDir, options.home, options.environment),
  );
  let ancestor = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      const resolvedAncestor = realpathSync(ancestor);
      return resolve(resolvedAncestor, ...suffix.reverse());
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return absolute;
      suffix.push(ancestor.slice(parent.length).replace(/^[/\\\\]/, ""));
      ancestor = parent;
    }
  }
}

/**
 * Canonicalize a rule. Existing symlink spellings retain a lexical rule and
 * also add the resolved target, so either name is covered by policy checks.
 */
export function canonicalizeRule(
  expression: string,
  options: CanonicalPathOptions = {},
): PathRule[] {
  const lexicalPath = resolve(
    expandPath(expression, options.baseDir, options.home, options.environment),
  );
  const canonicalPath = canonicalizePath(expression, options);
  const defaultKind = options.defaultKind ?? "dir";
  let kind = defaultKind;
  let materialized = false;
  try {
    kind = classifyExisting(lexicalPath);
  } catch {
    // An absent rule is retained as a directory destination for later masking.
  }
  const rules: PathRule[] = [{ configured: expression, path: lexicalPath, kind, materialized }];
  if (canonicalPath !== lexicalPath) {
    rules.push({ configured: expression, path: canonicalPath, kind, materialized });
  }
  return rules;
}

export function isUnder(candidate: string, root: string): boolean {
  const result = relative(resolve(root), resolve(candidate));
  return (
    result === "" || (result !== ".." && !result.startsWith(`..${sep}`) && !isAbsolute(result))
  );
}

export function dedupeRules(rules: readonly PathRule[]): PathRule[] {
  const seen = new Map<string, PathRule>();
  for (const rule of rules) {
    const previous = seen.get(rule.path);
    if (!previous || (rule.materialized && !previous.materialized)) seen.set(rule.path, rule);
  }
  return [...seen.values()];
}

export function collapseDescendants(rules: readonly PathRule[]): PathRule[] {
  const sorted = [...dedupeRules(rules)].sort((a, b) => a.path.length - b.path.length);
  return sorted.filter(
    (rule, index) => !sorted.slice(0, index).some((parent) => isUnder(rule.path, parent.path)),
  );
}

export function canonicalizeRules(
  expressions: readonly string[],
  options: CanonicalPathOptions = {},
): PathRule[] {
  return collapseDescendants(
    expressions.flatMap((expression) => canonicalizeRule(expression, options)),
  );
}

export function pathDisplay(rule: PathRule): string {
  return rule.configured;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function classifyPath(
  path: string,
  defaultKind: PathRule["kind"] = "dir",
): Promise<PathRule["kind"]> {
  try {
    const stats = await lstat(path);
    if (stats.isDirectory()) return "dir";
    if (stats.isSocket()) return "socket";
    return "file";
  } catch {
    return defaultKind;
  }
}

export async function materializeHomeRule(
  path: string,
  kind: PathRule["kind"],
  operations: MaterializationOperations = {
    mkdir: async (target, options) => mkdir(target, options),
    openExclusive: async (target, mode) => {
      const handle = await open(target, "wx", mode);
      await handle.close();
    },
  },
  homeRoot = homedir(),
): Promise<void> {
  if (!isUnder(path, homeRoot))
    throw new PolicyError(`Refusing to materialize outside home: ${path}`);
  try {
    if (kind === "file" || kind === "socket") await operations.openExclusive(path, 0o600);
    else await operations.mkdir(path, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    throw new PolicyError(`Could not materialize deny path ${path}: ${String(error)}`);
  }
}
