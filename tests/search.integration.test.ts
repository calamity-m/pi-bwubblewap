import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionResources, cleanupSessionResources } from "../src/backend/resources.ts";
import type { EffectivePolicy } from "../src/policy/types.ts";
import { createSessionRuntime } from "../src/runtime.ts";
import {
  createSandboxedFindDefinition,
  createSandboxedGrepDefinition,
} from "../src/tools/search.ts";

const skipReason =
  process.platform === "linux" && existsSync("/usr/bin/bwrap")
    ? undefined
    : "requires Linux bubblewrap";

test(
  "find traverses the backend view and cannot enter a denied subtree",
  { skip: skipReason },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bwubblewap-find-"));
    const denied = join(root, "secret");
    await mkdir(denied);
    await writeFile(join(root, "visible.ts"), "needle visible");
    await writeFile(join(denied, "hidden.ts"), "needle hidden");
    const resources = await createSessionResources();
    const runtime = createSessionRuntime();
    const rule = (path: string, kind: "dir" | "file") => ({
      configured: path,
      path,
      kind,
      materialized: false,
    });
    const policy: EffectivePolicy = Object.freeze({
      backend: "bwrap",
      denyRead: Object.freeze([rule(denied, "dir")]),
      denyWrite: Object.freeze([]),
      allowWrite: Object.freeze([
        rule(root, "dir"),
        rule(resources.scratchDir, "dir"),
        rule("/tmp", "dir"),
      ]),
      network: "off",
      allowedDomains: Object.freeze([]),
      allowedPorts: Object.freeze([]),
      unsandboxedCommands: Object.freeze([]),
      cwd: root,
      warnings: Object.freeze([]),
      configSources: Object.freeze([]),
      configValid: true,
    });
    runtime.mode = {
      kind: "active",
      policy,
      resources,
      probe: { ok: true, selectiveNetworkChecked: false },
    };
    try {
      const find = createSandboxedFindDefinition(root, () => runtime) as never as {
        execute: Function;
      };
      const result = await find.execute(
        "find",
        { pattern: "*.ts", path: root },
        undefined,
        undefined,
        { cwd: root },
      );
      assert.match(result.content[0].text, /visible\.ts/);
      assert.equal(result.content[0].text.includes("hidden.ts"), false);
      const grep = createSandboxedGrepDefinition(root, () => runtime) as never as {
        execute: Function;
      };
      const grepResult = await grep.execute(
        "grep",
        { pattern: "needle", path: root },
        undefined,
        undefined,
        { cwd: root },
      );
      assert.match(grepResult.content[0].text, /visible\.ts/);
      assert.equal(grepResult.content[0].text.includes("hidden.ts"), false);

      const fdPath = resources.fdPath;
      resources.fdPath = undefined;
      await assert.rejects(
        find.execute("find-missing", { pattern: "*.ts", path: root }, undefined, undefined, {
          cwd: root,
        }),
        /fd is unavailable/,
      );
      resources.fdPath = fdPath;
      const rgPath = resources.rgPath;
      resources.rgPath = undefined;
      await assert.rejects(
        grep.execute("grep-missing", { pattern: "needle", path: root }, undefined, undefined, {
          cwd: root,
        }),
        /ripgrep is unavailable/,
      );
      resources.rgPath = rgPath;
    } finally {
      await cleanupSessionResources(resources);
    }
  },
);
