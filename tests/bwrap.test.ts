import assert from "node:assert/strict";
import test from "node:test";
import { composeBwrapArgv, MAX_CHILD_STDIN_BYTES, runWrapped } from "../src/backend/bwrap.ts";
import type { SessionResources } from "../src/runtime.ts";
import type { EffectivePolicy } from "../src/policy/types.ts";

const resources: SessionResources = {
  sessionDir: "/tmp/session",
  scratchDir: "/tmp/session/scratch",
  runtimeDir: "/tmp/session/runtime",
  helperPath: "/tmp/session/runtime/fs-helper.mjs",
  emptyDir: "/tmp/session/runtime/masks/empty-dir",
  emptyFile: "/tmp/session/runtime/masks/empty-file",
  bwrapPath: "/usr/bin/bwrap",
  proxySocket: "/tmp/session/proxy.sock",
};
const policy: EffectivePolicy = Object.freeze({
  backend: "bwrap",
  denyRead: Object.freeze([]),
  denyWrite: Object.freeze([]),
  allowWrite: Object.freeze([]),
  network: "off",
  allowedDomains: Object.freeze([]),
  allowedPorts: Object.freeze([]),
  unsandboxedCommands: Object.freeze([]),
  cwd: process.cwd(),
  warnings: Object.freeze([]),
  configSources: Object.freeze([]),
  configValid: true,
});

test("bwrap argv uses an argv boundary and disables inherited proxy variables in off mode", () => {
  const argv = composeBwrapArgv(["/bin/echo", "hello; touch /tmp/nope"], policy, resources, {
    network: "off",
  });
  assert.equal(argv.includes("--"), true);
  assert.equal(argv.at(-1), "hello; touch /tmp/nope");
  assert.equal(argv.includes("--unsetenv"), true);
  assert.equal(argv.includes("/bin/sh"), false);
});

test("allow mode does not unshare the network", () => {
  const argv = composeBwrapArgv(["true"], policy, resources, { network: "allow" });
  assert.equal(argv.includes("--unshare-net"), false);
});

test("wrapped process limits reject oversized input and stderr", async () => {
  await assert.rejects(
    runWrapped([process.execPath, "-e", ""], {
      network: "off",
      stdin: Buffer.allocUnsafe(MAX_CHILD_STDIN_BYTES + 1),
    }),
    /input exceeds/,
  );
  await assert.rejects(
    runWrapped([process.execPath, "-e", "process.stderr.write(Buffer.alloc(65537))"], {
      network: "off",
    }),
    /stderr exceeds/,
  );
});
