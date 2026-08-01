import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  DEFAULT_ALLOW_WRITE,
  DEFAULT_ALLOWED_DOMAINS,
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_BACKEND,
  DEFAULT_DENY_READ,
  DEFAULT_DENY_WRITE,
  DEFAULT_NETWORK,
  DEFAULT_UNSANDBOXED_COMMANDS,
  defaultWritePaths,
} from "./defaults.ts";
import {
  canonicalizeRule,
  canonicalizeRules,
  collapseDescendants,
  expandPath,
  isUnder,
  materializeHomeRule,
  type MaterializationOperations,
} from "./paths.ts";
import { PolicyError, type EffectivePolicy, type PathRule } from "./types.ts";
import type { SessionResources } from "../runtime.ts";

export interface DefaultPolicyOptions {
  materializeHomeDeny?: boolean;
  materialization?: MaterializationOperations;
  environment?: NodeJS.ProcessEnv;
  home?: string;
}

function freezeRules(rules: PathRule[]): readonly PathRule[] {
  return Object.freeze(rules.map((rule) => Object.freeze({ ...rule })));
}

export function freezeEffectivePolicy(policy: EffectivePolicy): EffectivePolicy {
  return Object.freeze({
    ...policy,
    denyRead: freezeRules([...policy.denyRead]),
    denyWrite: freezeRules([...policy.denyWrite]),
    allowWrite: freezeRules([...policy.allowWrite]),
    allowedDomains: Object.freeze([...policy.allowedDomains]),
    allowedPorts: Object.freeze([...policy.allowedPorts]),
    unsandboxedCommands: Object.freeze([...policy.unsandboxedCommands]),
    warnings: Object.freeze([...policy.warnings]),
    configSources: Object.freeze([...policy.configSources]),
  });
}

function defaultDenyExpressions(environment: NodeJS.ProcessEnv, home: string): string[] {
  return DEFAULT_DENY_READ.map((expression) => {
    if (expression !== "$XDG_RUNTIME_DIR" || environment.XDG_RUNTIME_DIR) return expression;
    const fallback = `/run/user/${process.getuid?.() ?? 0}`;
    return existsSync(fallback) ? fallback : "";
  })
    .filter(Boolean)
    .map((expression) => (expression === "~" ? home : expression));
}

/** Build the immutable no-config policy used before configurable layers exist. */
export async function buildDefaultPolicy(
  cwd: string,
  resources: Pick<SessionResources, "scratchDir">,
  options: DefaultPolicyOptions = {},
): Promise<EffectivePolicy> {
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const warnings: string[] = [];
  const denyExpressions = defaultDenyExpressions(environment, home);
  if (!environment.XDG_RUNTIME_DIR && !existsSync(`/run/user/${process.getuid?.() ?? 0}`)) {
    warnings.push(
      "default denyRead path $XDG_RUNTIME_DIR was skipped because it is unset and its fallback is absent",
    );
  }

  const denyRead = collapseDescendants(
    denyExpressions.flatMap((expression) =>
      canonicalizeRule(expression, {
        baseDir: cwd,
        home,
        environment,
        defaultKind: expression === "~/.netrc" ? "file" : "dir",
      }),
    ),
  );
  const denyWrite = canonicalizeRules(DEFAULT_DENY_WRITE, { baseDir: cwd });
  const allowWrite = canonicalizeRules(
    [...DEFAULT_ALLOW_WRITE, ...defaultWritePaths(resolve(cwd), resources.scratchDir)],
    { baseDir: cwd, defaultKind: "dir" },
  );

  if (denyRead.some((rule) => isUnder(resolve(cwd), rule.path))) {
    throw new PolicyError("The current working directory is covered by a default denyRead path");
  }
  if (denyRead.some((rule) => isUnder(resolve(resources.scratchDir), rule.path))) {
    throw new PolicyError("The session scratch directory is covered by a default denyRead path");
  }

  if (options.materializeHomeDeny) {
    for (const rule of denyRead) {
      if (!rule.path.startsWith(resolve(home) + "/") && rule.path !== resolve(home)) continue;
      if (existsSync(rule.path)) continue;
      await materializeHomeRule(rule.path, rule.kind, options.materialization, home);
      rule.materialized = true;
      warnings.push(`materialized default denyRead path ${rule.configured}`);
    }
  }

  return freezeEffectivePolicy({
    backend: DEFAULT_BACKEND,
    denyRead,
    denyWrite,
    allowWrite,
    network: DEFAULT_NETWORK,
    allowedDomains: DEFAULT_ALLOWED_DOMAINS,
    allowedPorts: DEFAULT_ALLOWED_PORTS,
    unsandboxedCommands: DEFAULT_UNSANDBOXED_COMMANDS,
    cwd: resolve(cwd),
    warnings,
    configSources: [],
    configValid: true,
  });
}

export function expandConfiguredPath(expression: string, cwd: string): string {
  return expandPath(expression, cwd);
}
