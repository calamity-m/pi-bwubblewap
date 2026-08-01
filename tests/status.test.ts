import assert from "node:assert/strict";
import test from "node:test";
import { renderStatus } from "../src/status.ts";
import { createSessionRuntime } from "../src/runtime.ts";

test("status reports unavailable state without environment values", () => {
  const runtime = createSessionRuntime();
  runtime.mode = { kind: "unavailable", reason: "generated safe reason" };
  process.env.BW_STATUS_SECRET = "must-not-appear";
  try {
    const output = renderStatus(runtime, [], new Map());
    assert.match(output, /Sandbox: unavailable/);
    assert.match(output, /generated safe reason/);
    assert.equal(output.includes("must-not-appear"), false);
  } finally {
    delete process.env.BW_STATUS_SECRET;
  }
});
