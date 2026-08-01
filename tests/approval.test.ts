import assert from "node:assert/strict";
import test from "node:test";
import { requestApproval } from "../src/approval.ts";

function context(choices: string[], active = true) {
  let concurrent = 0;
  let maximum = 0;
  return {
    get concurrent() {
      return concurrent;
    },
    get maximum() {
      return maximum;
    },
    ctx: {
      hasUI: active,
      ui: {
        select: async () => {
          concurrent++;
          maximum = Math.max(maximum, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 5));
          concurrent--;
          return choices.shift();
        },
      },
    } as never,
  };
}

test("headless approval denies", async () => {
  const result = await requestApproval({ hasUI: false } as never, "host execution", "true");
  assert.equal(result, false);
});

test("approval prompts are serialized", async () => {
  const fixture = context(["Allow once", "Deny"]);
  const results = await Promise.all([
    requestApproval(fixture.ctx, "host execution", "one"),
    requestApproval(fixture.ctx, "host execution", "two"),
  ]);
  assert.deepEqual(results, [true, false]);
  assert.equal(fixture.maximum, 1);
});
