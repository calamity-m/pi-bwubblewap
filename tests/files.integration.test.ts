import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionResources, cleanupSessionResources } from "../src/backend/resources.ts";
import type { EffectivePolicy } from "../src/policy/types.ts";
import { createSessionRuntime } from "../src/runtime.ts";
import { createSandboxedFileDefinitions } from "../src/tools/files.ts";

const canRun = process.platform === "linux" && existsSync("/usr/bin/bwrap");
const skipReason = canRun ? undefined : "requires Linux bubblewrap at /usr/bin/bwrap";

test("read, write, edit, and ls use the sandbox helper", { skip: skipReason }, async () => {
  const root = await mkdtemp(join(tmpdir(), "bwubblewap-files-"));
  const resources = await createSessionResources();
  const runtime = createSessionRuntime();
  const denied = join(root, "denied.txt");
  const denyWrite = join(root, "readable.txt");
  await writeFile(denied, "generated file sentinel");
  await writeFile(denyWrite, "readable");
  const makeRule = (path: string, kind: "dir" | "file") => ({
    configured: path,
    path,
    kind,
    materialized: false,
  });
  const policy: EffectivePolicy = Object.freeze({
    backend: "bwrap",
    denyRead: Object.freeze([makeRule(denied, "file")]),
    denyWrite: Object.freeze([makeRule(denyWrite, "file")]),
    allowWrite: Object.freeze([
      makeRule(root, "dir"),
      makeRule(resources.scratchDir, "dir"),
      makeRule("/tmp", "dir"),
    ]),
    network: "off",
    allowedDomains: Object.freeze([]),
    allowedPorts: Object.freeze([]),
    unsandboxedCommands: Object.freeze([]),
    cwd: root,
    warnings: Object.freeze([]),
    configSources: Object.freeze([]),
    configValid: true,
  });
  runtime.mode = {
    kind: "active",
    policy,
    resources,
    probe: { ok: true, selectiveNetworkChecked: false },
  };
  const tools = createSandboxedFileDefinitions(root, () => runtime) as never as {
    read: { execute: Function };
    write: { execute: Function };
    edit: { execute: Function };
    ls: { execute: Function };
  };
  const ctx = { cwd: root };
  try {
    const read = await tools.read.execute("read", { path: denyWrite }, undefined, undefined, ctx);
    assert.equal(read.content[0].text, "readable");
    await writeFile(denyWrite, "fresh");
    const fresh = await tools.read.execute(
      "read-fresh",
      { path: denyWrite },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(fresh.content[0].text, "fresh");

    const imagePath = join(root, "pixel.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const image = await tools.read.execute(
      "read-image",
      { path: imagePath },
      undefined,
      undefined,
      ctx,
    );
    const imageContent = image.content.find((item: { type: string }) => item.type === "image");
    assert.ok(imageContent);
    assert.equal(imageContent.mimeType, "image/png");
    assert.equal(imageContent.data.length > 0, true);

    await assert.rejects(
      tools.read.execute("read-denied", { path: denied }, undefined, undefined, ctx),
      /read denied/,
    );
    await assert.rejects(
      tools.write.execute(
        "write-denied",
        { path: denyWrite, content: "nope" },
        undefined,
        undefined,
        ctx,
      ),
      /write denied/,
    );

    const created = join(root, "created.txt");
    await tools.write.execute(
      "write",
      { path: created, content: "created" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(await readFile(created, "utf8"), "created");

    const edited = join(root, "edited.txt");
    await writeFile(edited, "before");
    await tools.edit.execute(
      "edit",
      { path: edited, edits: [{ oldText: "before", newText: "after" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(await readFile(edited, "utf8"), "after");

    const listed = await tools.ls.execute("ls", { path: root }, undefined, undefined, ctx);
    assert.match(listed.content[0].text, /created\.txt/);
  } finally {
    await cleanupSessionResources(resources);
  }
});
