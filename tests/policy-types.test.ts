import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ALLOWED_DOMAINS, DEFAULT_DENY_READ } from "../src/policy/defaults.ts";

test("default policy includes required secret and network defaults", () => {
  assert.ok(DEFAULT_DENY_READ.includes("~/.ssh"));
  assert.ok(DEFAULT_DENY_READ.includes("/run/docker.sock"));
  assert.deepEqual(DEFAULT_ALLOWED_DOMAINS.slice(-2), ["registry.npmjs.org", "*.npmjs.org"]);
});
