import assert from "node:assert/strict";
import { access, chmod, rm, rmdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";
import { cleanupSessionResources, createSessionResources } from "../src/backend/resources.ts";

test("session resources have private masks and cleanup is idempotent", async () => {
  const resources = await createSessionResources();
  try {
    assert.equal((await stat(resources.sessionDir)).mode & 0o777, 0o700);
    assert.equal((await stat(resources.emptyDir)).mode & 0o777, 0);
    assert.equal((await stat(resources.emptyFile)).mode & 0o777, 0);
    await access(resources.helperPath, constants.R_OK);
  } finally {
    await cleanupSessionResources(resources);
    await cleanupSessionResources(resources);
  }
  await assert.rejects(stat(resources.sessionDir), { code: "ENOENT" });
});

test("cleanup tolerates an already absent mask directory", async () => {
  const resources = await createSessionResources();
  try {
    await chmod(resources.emptyDir, 0o700);
    await rmdir(resources.emptyDir);
    await cleanupSessionResources(resources);
    await assert.rejects(stat(resources.sessionDir), { code: "ENOENT" });
  } finally {
    await cleanupSessionResources(resources);
  }
});

test("cleanup tolerates an already absent session directory", async () => {
  const resources = await createSessionResources();
  try {
    await chmod(resources.emptyDir, 0o700);
    await rm(resources.sessionDir, { recursive: true });
    await cleanupSessionResources(resources);
    await assert.rejects(stat(resources.sessionDir), { code: "ENOENT" });
  } finally {
    await cleanupSessionResources(resources);
  }
});

test("cleanup preserves errors other than ENOENT", async () => {
  const resources = await createSessionResources();
  try {
    // A file used as the session root causes ENOTDIR, even when run as root.
    await assert.rejects(cleanupSessionResources({ sessionDir: resources.emptyFile }), {
      code: "ENOTDIR",
    });
    assert.equal((await stat(resources.emptyDir)).mode & 0o777, 0);
  } finally {
    await cleanupSessionResources(resources);
  }
});
