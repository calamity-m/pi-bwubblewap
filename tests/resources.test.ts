import assert from "node:assert/strict";
import { access, stat } from "node:fs/promises";
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
});
