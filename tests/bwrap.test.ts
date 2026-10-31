import assert from "node:assert/strict";
import test from "node:test";
import {
  BwrapBackend,
  composeBwrapArgv,
  MAX_CHILD_STDIN_BYTES,
  runWrapped,
} from "../src/backend/bwrap.ts";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("probe helpers use resolved Node and scratch failures include redacted stderr", async (t) => {
  const sessionDir = await mkdtemp(join(tmpdir(), "bw-probe-test-"));
  t.after(() => rm(sessionDir, { recursive: true, force: true }));
  const scratchDir = join(sessionDir, "scratch");
  await mkdir(scratchDir);
  const probeResources = {
    ...resources,
    sessionDir,
    scratchDir,
    runtimeDir: join(sessionDir, "runtime"),
    nodePath: "/actual/node",
  };
  const secret = "/private/home/.pi/agent";
  const probePolicy: EffectivePolicy = {
    ...policy,
    denyRead: [{ path: secret, configured: "~/.pi/agent", kind: "dir", materialized: false }],
  };
  const helpers: string[][] = [];
  const backend = new BwrapBackend(async (argv) => {
    const command = argv.slice(argv.indexOf("--") + 1);
    if (command[0] === "/bin/true")
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    helpers.push(command);
    return {
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(`EACCES ${secret} ${sessionDir}/file bw:secret-token@localhost`),
    };
  });
  const probe = await backend.probe(probePolicy, probeResources);
  assert.equal(probe.ok, false);
  assert.match(probe.reason!, /probe scratch write check failed/);
  assert.match(probe.reason!, /EACCES ~\/\.pi\/agent \{session\}\/file bw:\{token\}@localhost/);
  assert.equal(probe.reason!.includes(secret), false);
  assert.equal(probe.reason!.includes(sessionDir), false);
  assert.equal(probe.reason!.includes("secret-token"), false);
  assert.deepEqual(
    helpers.map((argv) => argv[0]),
    ["/actual/node", "/actual/node"],
  );
  assert.deepEqual(
    helpers.map((argv) => argv[2]),
    ["read-r", "write"],
  );

  const successfulHelpers: string[][] = [];
  const successfulBackend = new BwrapBackend(async (argv) => {
    const command = argv.slice(argv.indexOf("--") + 1);
    if (command[0] !== "/bin/true") successfulHelpers.push(command);
    const exitCode =
      command[0] === "/bin/true" || command[3] === join(scratchDir, "probe-write") ? 0 : 1;
    return { exitCode, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
  assert.equal((await successfulBackend.probe(probePolicy, probeResources)).ok, true);
  assert.deepEqual(
    successfulHelpers.map((argv) => argv[0]),
    ["/actual/node", "/actual/node", "/actual/node"],
  );
  assert.deepEqual(
    successfulHelpers.map((argv) => argv[2]),
    ["read-r", "write", "write"],
  );
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
