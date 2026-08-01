import { readFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildDefaultPolicy, freezeEffectivePolicy } from "./default-policy.ts";
import { canonicalizeRules, isUnder } from "./paths.ts";
import {
  DEFAULT_ALLOWED_DOMAINS,
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_UNSANDBOXED_COMMANDS,
} from "./defaults.ts";
import type { BwubblewapConfig, EffectivePolicy, NetworkMode, PathRule } from "./types.ts";
import type { SessionResources } from "../runtime.ts";

const ROOT_KEYS = new Set([
  "backend",
  "denyRead",
  "denyWrite",
  "allowWrite",
  "unsandboxedCommands",
  "network",
]);
const NETWORK_KEYS = new Set(["mode", "allowedDomains", "allowedPorts"]);
const MODES = new Set<NetworkMode>(["deny", "allow", "off"]);

export interface PolicyContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

interface LoadedLayer {
  config?: BwubblewapConfig;
  valid: boolean;
  warning?: string;
  source?: string;
}

function invalid(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function stringArray(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    invalid(path, "must be a non-empty string array");
  }
  return value as string[];
}

function validateDomains(value: unknown, path: string): string[] {
  const domains = stringArray(value, path);
  for (const domain of domains) {
    if (
      domain !== domain.toLowerCase() ||
      /[/:@\s]/.test(domain) ||
      domain.endsWith(".") ||
      domain.includes("..")
    ) {
      invalid(path, `invalid domain pattern ${domain}`);
    }
    if (domain.startsWith("*.") && domain.slice(2).includes("*"))
      invalid(path, `invalid wildcard ${domain}`);
    if (!domain.startsWith("*.") && domain.includes("*"))
      invalid(path, `invalid wildcard ${domain}`);
  }
  return [...new Set(domains)];
}

function validatePorts(value: unknown, path: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    invalid(path, "must contain integer ports from 1 through 65535");
  }
  return [...new Set(value as number[])];
}

export function validateConfig(value: unknown, source: string): BwubblewapConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(source, "root must be an object");
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object))
    if (!ROOT_KEYS.has(key)) invalid(source, `unknown key ${key}`);
  const config: BwubblewapConfig = {};
  if (object.backend !== undefined) {
    if (object.backend !== "bwrap" && object.backend !== "docker")
      invalid(`${source}.backend`, "must be bwrap or docker");
    config.backend = object.backend;
  }
  for (const key of ["denyRead", "denyWrite", "allowWrite", "unsandboxedCommands"] as const) {
    if (object[key] !== undefined) config[key] = stringArray(object[key], `${source}.${key}`);
  }
  for (const pattern of config.unsandboxedCommands ?? []) {
    const candidate = pattern.trim();
    const firstStar = candidate.indexOf("*");
    if (
      !candidate ||
      candidate === "*" ||
      (firstStar >= 0 &&
        (firstStar !== candidate.length - 1 || candidate.indexOf("*", firstStar + 1) >= 0))
    ) {
      invalid(`${source}.unsandboxedCommands`, `invalid exact/prefix pattern ${pattern}`);
    }
  }
  if (object.network !== undefined) {
    if (!object.network || typeof object.network !== "object" || Array.isArray(object.network))
      invalid(`${source}.network`, "must be an object");
    const network = object.network as Record<string, unknown>;
    for (const key of Object.keys(network))
      if (!NETWORK_KEYS.has(key)) invalid(`${source}.network`, `unknown key ${key}`);
    config.network = {};
    if (network.mode !== undefined) {
      if (typeof network.mode !== "string" || !MODES.has(network.mode as NetworkMode))
        invalid(`${source}.network.mode`, "must be deny, allow, or off");
      config.network.mode = network.mode as NetworkMode;
    }
    if (network.allowedDomains !== undefined)
      config.network.allowedDomains = validateDomains(
        network.allowedDomains,
        `${source}.network.allowedDomains`,
      );
    if (network.allowedPorts !== undefined)
      config.network.allowedPorts = validatePorts(
        network.allowedPorts,
        `${source}.network.allowedPorts`,
      );
  }
  return config;
}

async function loadLayer(path: string): Promise<LoadedLayer> {
  if (!existsSync(path)) return { valid: true };
  try {
    return {
      config: validateConfig(JSON.parse(await readFile(path, "utf8")), path),
      valid: true,
      source: path,
    };
  } catch (error) {
    return {
      valid: false,
      warning: `${path}: ${error instanceof Error ? error.message : String(error)}`,
      source: path,
    };
  }
}

function sourceRules(
  expressions: readonly string[] | undefined,
  baseDir: string,
  home: string,
  environment: NodeJS.ProcessEnv,
): PathRule[] {
  if (!expressions) return [];
  const rules = canonicalizeRules(expressions, { baseDir, home, environment });
  for (const rule of rules) {
    try {
      lstatSync(rule.path);
    } catch {
      throw new Error(`configured path does not exist: ${rule.configured}`);
    }
  }
  return rules;
}

function appendRules(...groups: PathRule[][]): PathRule[] {
  const map = new Map<string, PathRule>();
  for (const group of groups) for (const rule of group) map.set(rule.path, rule);
  return [...map.values()];
}

export interface BuildPolicyOptions {
  globalPath?: string;
  projectPath?: string;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  materializeHomeDeny?: boolean;
}

export async function buildEffectivePolicy(
  ctx: PolicyContext,
  resources: SessionResources,
  options: BuildPolicyOptions = {},
): Promise<EffectivePolicy> {
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const defaults = await buildDefaultPolicy(ctx.cwd, resources, {
    materializeHomeDeny: options.materializeHomeDeny ?? true,
    home,
    environment,
  });
  const globalPath = options.globalPath ?? join(getAgentDir(), "bwubblewap.json");
  const projectPath =
    options.projectPath ?? join(ctx.cwd, CONFIG_DIR_NAME, "extensions", "bwubblewap.json");
  const global = await loadLayer(globalPath);
  const warnings = [...defaults.warnings];
  if (global.warning) warnings.push(`global config ignored: ${global.warning}`);
  const trusted = ctx.isProjectTrusted();
  const project = trusted
    ? await loadLayer(projectPath)
    : existsSync(projectPath)
      ? {
          valid: true,
          warning: `ignored project config because project is not trusted`,
        }
      : { valid: true };
  if (project.warning) warnings.push(project.warning);
  let denyRead = [...defaults.denyRead];
  let denyWrite = [...defaults.denyWrite];
  let allowWrite = [...defaults.allowWrite];
  let backend = defaults.backend;
  let network = defaults.network;
  let allowedDomains = [...DEFAULT_ALLOWED_DOMAINS];
  let allowedPorts = [...DEFAULT_ALLOWED_PORTS];
  let unsandboxedCommands = [...DEFAULT_UNSANDBOXED_COMMANDS];
  let configValid = global.valid && project.valid;

  if (global.valid && global.config) {
    try {
      if (global.config.denyRead)
        denyRead = sourceRules(global.config.denyRead, dirname(globalPath), home, environment);
      if (global.config.denyWrite)
        denyWrite = sourceRules(global.config.denyWrite, dirname(globalPath), home, environment);
      if (global.config.allowWrite)
        allowWrite = appendRules(
          sourceRules(global.config.allowWrite, dirname(globalPath), home, environment),
          [...allowWrite],
        );
      if (global.config.backend) backend = global.config.backend;
      if (global.config.unsandboxedCommands)
        unsandboxedCommands = global.config.unsandboxedCommands.filter(
          (command) => command.trim() !== "*" && command.trim() !== "",
        );
      if (global.config.network?.mode) network = global.config.network.mode;
      if (global.config.network?.allowedDomains)
        allowedDomains = global.config.network.allowedDomains;
      if (global.config.network?.allowedPorts) allowedPorts = global.config.network.allowedPorts;
    } catch (error) {
      configValid = false;
      warnings.push(
        `global config ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
      denyRead = [...defaults.denyRead];
      denyWrite = [...defaults.denyWrite];
      allowWrite = [...defaults.allowWrite];
      backend = defaults.backend;
      network = defaults.network;
      unsandboxedCommands = [];
    }
  }
  if (project.valid && project.config) {
    try {
      if (project.config.denyRead)
        denyRead = appendRules(
          denyRead,
          sourceRules(project.config.denyRead, ctx.cwd, home, environment),
        );
      if (project.config.denyWrite)
        denyWrite = appendRules(
          denyWrite,
          sourceRules(project.config.denyWrite, ctx.cwd, home, environment),
        );
      if (project.config.allowWrite) {
        const projectWrites = sourceRules(project.config.allowWrite, ctx.cwd, home, environment);
        for (const rule of projectWrites) {
          if (isUnder(rule.path, resolve(ctx.cwd))) allowWrite = appendRules(allowWrite, [rule]);
          else warnings.push(`project allowWrite ignored outside cwd: ${rule.configured}`);
        }
      }
      for (const key of ["backend", "network", "unsandboxedCommands"] as const)
        if (project.config[key] !== undefined)
          warnings.push(`project ${key} ignored because project config may only tighten policy`);
    } catch (error) {
      configValid = false;
      warnings.push(
        `project config ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const policy = {
    ...defaults,
    backend,
    denyRead,
    denyWrite,
    allowWrite,
    network,
    allowedDomains,
    allowedPorts,
    unsandboxedCommands: configValid ? unsandboxedCommands : [],
    warnings,
    configSources: [global.source, project.source].filter((source): source is string =>
      Boolean(source),
    ),
    configValid,
  };
  return freezeEffectivePolicy(policy);
}
