import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDefaultPolicy } from "../src/policy/default-policy.ts";
import { createSessionResources, cleanupSessionResources } from "../src/backend/resources.ts";
import { createSessionRuntime } from "../src/runtime.ts";
import { createSandboxedBashDefinition } from "../src/tools/bash.ts";

const fakeContext = {
  model: undefined,
  thinkingLevel: undefined,
  sessionManager: {
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
};

test("sandboxed bash has a strict extended schema and runs through bwrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "bwubblewap-bash-"));
  const resources = await createSessionResources();
  const runtime = createSessionRuntime();
  const policy = await buildDefaultPolicy(root, resources, { environment: process.env });
  runtime.mode = {
    kind: "active",
    policy: Object.freeze({ ...policy, network: "off" as const }),
    resources,
    probe: { ok: true, selectiveNetworkChecked: false },
  };
  const tool = createSandboxedBashDefinition(root, () => runtime) as never as {
    parameters: { additionalProperties?: boolean };
    execute: Function;
  };
  assert.equal(tool.parameters.additionalProperties, false);
  try {
    process.env.BW_SENTINEL = "sandbox-ok";
    const result = await tool.execute(
      "call-1",
      { command: "printf '%s' \"$BW_SENTINEL\"" },
      undefined,
      undefined,
      fakeContext,
    );
    assert.equal(result.content[0].text, "sandbox-ok");

    const denied = join(root, "denied.txt");
    await writeFile(denied, "generated bash sentinel");
    runtime.mode = {
      ...runtime.mode,
      policy: Object.freeze({
        ...runtime.mode.policy,
        denyRead: Object.freeze([
          ...runtime.mode.policy.denyRead,
          { configured: denied, path: denied, kind: "file" as const, materialized: false },
        ]),
      }),
    };
    const deniedResult = await tool.execute(
      "call-2",
      { command: `cat ${denied}` },
      undefined,
      undefined,
      fakeContext,
    );
    assert.equal(deniedResult.isError, true);
    assert.doesNotMatch(deniedResult.content[0].text, /generated bash sentinel/);
    assert.notEqual(deniedResult.structuredContent.exit_code, 0);
    process.env.BWUBBLEWAP_HARMLESS_SENTINEL = "inherited-ok";
    try {
      const inherited = await tool.execute(
        "call-env",
        {
          command:
            'printf \'%s|%s|%s\' "$BWUBBLEWAP_HARMLESS_SENTINEL" "${HTTP_PROXY-unset}" "${NO_PROXY-unset}"',
        },
        undefined,
        undefined,
        fakeContext,
      );
      assert.equal(inherited.content[0].text, "inherited-ok|unset|unset");
    } finally {
      delete process.env.BWUBBLEWAP_HARMLESS_SENTINEL;
    }

    runtime.mode = {
      ...runtime.mode,
      policy: Object.freeze({
        ...runtime.mode.policy,
        unsandboxedCommands: Object.freeze(["printf auto-approved*"]),
      }),
    };
    const auto = await tool.execute(
      "call-3",
      { command: "printf auto-approved", unsandboxed: true },
      undefined,
      undefined,
      fakeContext,
    );
    assert.equal(auto.content[0].text, "auto-approved");
    assert.equal(runtime.counters.autoApproved, 1);
    await assert.rejects(
      tool.execute(
        "call-4",
        { command: "printf auto-approved && printf unsafe", unsandboxed: true },
        undefined,
        undefined,
        { ...fakeContext, hasUI: false },
      ),
      /escalation denied/,
    );
  } finally {
    delete process.env.BW_SENTINEL;
    await cleanupSessionResources(resources);
  }
});
