import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalizePath, canonicalizeRule, isUnder } from "../src/policy/paths.ts";

test("isUnder uses path segment boundaries", () => {
  assert.equal(isUnder("/a/b", "/a"), true);
  assert.equal(isUnder("/a/bc", "/a/b"), false);
});

test("canonicalizes through a symlinked ancestor and keeps absent suffix", () => {
  assert.equal(canonicalizePath("/var/run/example-that-is-absent"), "/run/example-that-is-absent");
});

test("emits lexical and target rules for a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "bwubblewap-paths-"));
  const target = join(root, "target");
  const link = join(root, "link");
  await writeFile(target, "sentinel");
  await symlink(target, link);
  const rules = canonicalizeRule(link, { defaultKind: "file" });
  assert.deepEqual(rules.map((rule) => rule.path).sort(), [link, target].sort());
});
