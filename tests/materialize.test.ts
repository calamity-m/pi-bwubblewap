import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeHomeRule, type MaterializationOperations } from "../src/policy/paths.ts";

function fakeOperations(code?: string): MaterializationOperations & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async mkdir(path, options) {
      calls.push(`mkdir:${path}:${options.mode.toString(8)}`);
      if (code) throw Object.assign(new Error(code), { code });
    },
    async openExclusive(path, mode) {
      calls.push(`open:${path}:${mode.toString(8)}`);
      if (code) throw Object.assign(new Error(code), { code });
    },
  };
}

test("home materialization uses restrictive exclusive modes", async () => {
  const root = await mkdtemp(join(homedir(), ".bwubblewap-test-"));
  const operations = fakeOperations();
  try {
    await materializeHomeRule(join(root, "secret-dir"), "dir", operations);
    await materializeHomeRule(join(root, "secret-file"), "file", operations);
    assert.deepEqual(operations.calls, [
      `mkdir:${join(root, "secret-dir")}:700`,
      `open:${join(root, "secret-file")}:600`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EEXIST is treated as a safe winner and outside-home paths are rejected", async () => {
  const root = await mkdtemp(join(homedir(), ".bwubblewap-race-"));
  const operations = fakeOperations("EEXIST");
  try {
    await materializeHomeRule(join(root, "winner"), "dir", operations);
    assert.equal(operations.calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await assert.rejects(
    materializeHomeRule(join(tmpdir(), "not-home"), "dir", fakeOperations()),
    /outside home/,
  );
});
