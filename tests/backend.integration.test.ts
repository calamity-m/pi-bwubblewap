import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BwrapBackend, runWrapped } from "../src/backend/bwrap.ts";
import { cleanupSessionResources, createSessionResources } from "../src/backend/resources.ts";
import type { EffectivePolicy } from "../src/policy/types.ts";
import type { SessionResources } from "../src/runtime.ts";
import { helperArgv } from "../src/backend/node-runtime.ts";

const canRun = process.platform === "linux" && existsSync("/usr/bin/bwrap");
const skipReason = canRun ? undefined : "requires Linux bubblewrap at /usr/bin/bwrap";

function policy(cwd: string, resources: { scratchDir: string }, denied: string[]): EffectivePolicy {
  return Object.freeze({
    backend: "bwrap",
    denyRead: Object.freeze(
      denied.map((path) => ({
        configured: path,
        path,
        kind: "file" as const,
        materialized: false,
      })),
    ),
    denyWrite: Object.freeze([]),
    allowWrite: Object.freeze([
      { configured: cwd, path: cwd, kind: "dir" as const, materialized: false },
      {
        configured: resources.scratchDir,
        path: resources.scratchDir,
        kind: "dir" as const,
        materialized: false,
      },
      { configured: "/tmp", path: "/tmp", kind: "dir" as const, materialized: false },
    ]),
    network: "off",
    allowedDomains: Object.freeze([]),
    allowedPorts: Object.freeze([]),
    unsandboxedCommands: Object.freeze([]),
    cwd,
    warnings: Object.freeze([]),
    configSources: Object.freeze([]),
    configValid: true,
  });
}

async function helper(resources: SessionResources, action: string, path: string, input?: string) {
  const backend = new BwrapBackend();
  const p = currentPolicy!;
  const argv = backend.wrap(helperArgv(resources, action, path), p, currentResources!, {
    network: "off",
    stdin: input,
  });
  return runWrapped(argv, { network: "off", stdin: input });
}

let currentPolicy: EffectivePolicy | undefined;
let currentResources: Awaited<ReturnType<typeof createSessionResources>> | undefined;

test("bubblewrap enforces denied reads and writable mounts", { skip: skipReason }, async () => {
  const root = await mkdtemp(join(tmpdir(), "bwubblewap-integration-"));
  const denied = join(root, "denied.txt");
  await writeFile(denied, "generated sentinel must not escape");
  const resources = await createSessionResources();
  currentResources = resources;
  currentPolicy = policy(root, resources, [denied]);
  try {
    const probe = await new BwrapBackend().probe(currentPolicy, resources);
    assert.equal(probe.ok, true, probe.reason);

    const read = await helper(resources, "read-r", denied);
    assert.notEqual(read.exitCode, 0);
    assert.equal(read.stdout.includes("generated sentinel"), false);

    const projectFile = join(root, "project.txt");
    assert.equal((await helper(resources, "write", projectFile, "project")).exitCode, 0);
    assert.deepEqual(await readFile(projectFile, "utf8"), "project");

    currentPolicy = Object.freeze({
      ...currentPolicy,
      denyWrite: Object.freeze([
        {
          configured: projectFile,
          path: projectFile,
          kind: "file" as const,
          materialized: false,
        },
      ]),
    });
    const denyWriteRead = await helper(resources, "read-r", projectFile);
    assert.equal(denyWriteRead.exitCode, 0);
    assert.equal(denyWriteRead.stdout.toString(), "project");
    assert.notEqual((await helper(resources, "write", projectFile, "changed")).exitCode, 0);
    assert.deepEqual(await readFile(projectFile, "utf8"), "project");

    const tmpFile = join("/tmp", `bwubblewap-${process.pid}.txt`);
    try {
      assert.equal((await helper(resources, "write", tmpFile, "shared")).exitCode, 0);
      assert.deepEqual(await readFile(tmpFile, "utf8"), "shared");
    } finally {
      await unlink(tmpFile).catch(() => undefined);
    }

    const outside = `/var/tmp/bwubblewap-outside-${process.pid}`;
    const outsideResult = await helper(resources, "write", outside, "must fail");
    assert.notEqual(outsideResult.exitCode, 0);
    assert.equal(existsSync(outside), false);
  } finally {
    await cleanupSessionResources(resources);
    currentResources = undefined;
    currentPolicy = undefined;
  }
});

test(
  "a checked path swapped to a denied symlink remains unreadable",
  { skip: skipReason },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bwubblewap-race-"));
    const safe = join(root, "safe.txt");
    const denied = join(root, "denied.txt");
    await writeFile(safe, "safe");
    await writeFile(denied, "race sentinel");
    const resources = await createSessionResources();
    currentResources = resources;
    currentPolicy = policy(root, resources, [denied]);
    try {
      assert.equal((await lstat(safe)).isFile(), true);
      await unlink(safe);
      await symlink(denied, safe);
      const result = await helper(resources, "read-r", safe);
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.stdout.includes("race sentinel"), false);
    } finally {
      await cleanupSessionResources(resources);
      currentResources = undefined;
      currentPolicy = undefined;
    }
  },
);
