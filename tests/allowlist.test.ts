import assert from "node:assert/strict";
import test from "node:test";
import { containsShellOperator, matchesUnsandboxedCommand } from "../src/policy/allowlist.ts";

test("allowlist supports exact and trailing-prefix matches", () => {
  assert.equal(matchesUnsandboxedCommand("git status", ["git status"]), true);
  assert.equal(matchesUnsandboxedCommand("git push origin main", ["git push *"]), true);
  assert.equal(matchesUnsandboxedCommand("git statusx", ["git status"]), false);
  assert.equal(matchesUnsandboxedCommand("anything", ["*"]), false);
});

test("shell operators always prevent auto-approval", () => {
  for (const operator of ["&&", "||", "|", ";", "\n", "\r", "$(", "`", "&", ">", "<"]) {
    assert.equal(containsShellOperator(`git status ${operator} cat secret`), true, operator);
    assert.equal(
      matchesUnsandboxedCommand(`git status ${operator} cat secret`, ["git status *"]),
      false,
      operator,
    );
  }
});
