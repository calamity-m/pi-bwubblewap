import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { helperArgv, resolveNodeRuntime } from "../src/backend/node-runtime.ts";
import { BwrapBackend } from "../src/backend/bwrap.ts";
import type { SessionResources, SessionRuntime } from "../src/runtime.ts";
import {
  createReadOperations,
  createWriteOperations,
  createEditOperations,
  createLsOperations,
} from "../src/backend/file-operations.ts";
import type { EffectivePolicy } from "../src/policy/types.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "bw-node-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Node-hosted Pi uses its validated Node executable even without PATH", () => {
  assert.equal(resolveNodeRuntime(process.execPath, ""), realpathSync(process.execPath));
});

test("standalone Pi is never executed; helpers use actual Node from PATH", async (t) => {
  const root = await fixture(t);
  const pi = join(root, "pi");
  const marker = join(root, "pi-was-launched");
  await writeFile(pi, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  await chmod(pi, 0o755);
  await symlink(process.execPath, join(root, "node"));
  const nodePath = resolveNodeRuntime(pi, root);
  assert.equal(nodePath, realpathSync(process.execPath));
  assert.equal(existsSync(marker), false);
  assert.deepEqual(
    helperArgv({ nodePath, helperPath: "/helper.mjs" } as SessionResources, "read-r", "/file"),
    [nodePath, "/helper.mjs", "read-r", "/file"],
  );
});

test("non-Node node candidate is rejected and nodejs fallback is validated", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "node"), "#!/bin/sh\necho v22.19.0\n");
  await chmod(join(root, "node"), 0o755);
  assert.equal(resolveNodeRuntime("/standalone/pi", root), undefined);
  await symlink(process.execPath, join(root, "nodejs"));
  assert.equal(resolveNodeRuntime("/standalone/pi", root), realpathSync(process.execPath));
});

test("version-manager shim resolves to the actual Node executable", async (t) => {
  const root = await fixture(t);
  const node = process.execPath.replaceAll("'", "'\"'\"'");
  await writeFile(join(root, "node"), `#!/bin/sh\nexec '${node}' "$@"\n`);
  await chmod(join(root, "node"), 0o755);
  assert.equal(resolveNodeRuntime("/standalone/pi", root), realpathSync(process.execPath));
});

test("missing Node fails closed before any sandbox subprocess is invoked", async () => {
  assert.equal(resolveNodeRuntime("/standalone/pi", "/nonexistent/bw-node-test"), undefined);
  const resources = { bwrapPath: "/usr/bin/bwrap" } as SessionResources;
  assert.throws(() => helperArgv(resources, "write", "/tmp/file"), /No working Node.js runtime/);
  const backend = new BwrapBackend(async () => {
    throw new Error("must not spawn");
  });
  const probe = await backend.probe({} as EffectivePolicy, resources);
  assert.equal(probe.ok, false);
  assert.match(probe.reason!, /Install Node.js/);
  assert.doesNotMatch(probe.reason!, /apt|bubblewrap is not installed/);

  const runtime: SessionRuntime = {
    mode: {
      kind: "active",
      resources,
      policy: {} as EffectivePolicy,
      probe: { ok: true, selectiveNetworkChecked: false },
    },
    counters: { prompted: 0, approved: 0, autoApproved: 0, denied: 0 },
  };
  const read = createReadOperations(() => runtime);
  const edit = createEditOperations(() => runtime);
  const write = createWriteOperations(() => runtime);
  const ls = createLsOperations(() => runtime);
  for (const invoke of [
    () => read.readFile("/file"),
    () => edit.readFile("/file"),
    () => edit.writeFile("/file", "content"),
    () => write.mkdir("/directory"),
    () => write.writeFile("/file", "content"),
    () => ls.stat("/file"),
    () => ls.readdir("/directory"),
  ])
    await assert.rejects(async () => invoke(), /No working Node.js runtime/);
});
