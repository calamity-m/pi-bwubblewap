import assert from "node:assert/strict";
import test from "node:test";
import { buildDefaultPolicy } from "../src/policy/default-policy.ts";
import { isUnder } from "../src/policy/paths.ts";

test("default policy allows cwd, scratch, and host tmp writes", async () => {
  const policy = await buildDefaultPolicy(
    "/workspace",
    { scratchDir: "/tmp/session-scratch" },
    {
      environment: { PATH: "/bin" },
      home: "/home/tester",
    },
  );
  assert.equal(policy.network, "deny");
  assert.equal(policy.backend, "bwrap");
  assert.equal(
    policy.allowWrite.some((rule) => rule.path === "/workspace"),
    true,
  );
  assert.equal(
    policy.allowWrite.some((rule) => isUnder("/tmp/session-scratch", rule.path)),
    true,
  );
  assert.equal(
    policy.allowWrite.some((rule) => rule.path === "/tmp"),
    true,
  );
  assert.equal(
    policy.denyRead.some((rule) => isUnder("/home/tester/.ssh/id", rule.path)),
    true,
  );
  assert.equal(policy.denyRead.find((rule) => rule.configured === "~/.netrc")?.kind, "file");
  assert.equal(Object.isFrozen(policy), true);
});

test("unset optional XDG runtime path is warned and skipped", async () => {
  const policy = await buildDefaultPolicy(
    "/workspace",
    { scratchDir: "/tmp/scratch" },
    {
      environment: {},
      home: "/home/tester",
    },
  );
  assert.equal(
    policy.warnings.some((warning) => warning.includes("XDG_RUNTIME_DIR")) ||
      policy.denyRead.some((rule) => rule.path === "/run/user/1000"),
    true,
  );
});

test("cwd under a deny rule fails closed", async () => {
  await assert.rejects(
    buildDefaultPolicy(
      "/home/tester/.ssh/project",
      { scratchDir: "/tmp/scratch" },
      {
        environment: {},
        home: "/home/tester",
      },
    ),
    /working directory.*denyRead/i,
  );
});
