import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEffectivePolicy, validateConfig } from "../src/policy/config.ts";
import { cleanupSessionResources, createSessionResources } from "../src/backend/resources.ts";

test("config validation rejects unknown keys, malformed domains, and invalid ports", () => {
  assert.throws(() => validateConfig({ nope: true }, "config"), /unknown key/);
  assert.throws(
    () => validateConfig({ network: { allowedDomains: ["https://example.com"] } }, "config"),
    /invalid domain/,
  );
  assert.throws(
    () => validateConfig({ network: { allowedPorts: [0] } }, "config"),
    /integer ports/,
  );
  assert.throws(() => validateConfig({ denyRead: ["", 1] }, "config"), /non-empty string array/);
  assert.throws(
    () => validateConfig({ unsandboxedCommands: ["*"] }, "config"),
    /invalid exact\/prefix pattern/,
  );
});

test("valid config preserves declared policy fields", () => {
  assert.deepEqual(
    validateConfig(
      {
        denyRead: [".env"],
        network: {
          mode: "deny",
          allowedDomains: ["example.com", "*.example.com"],
          allowedPorts: [443],
        },
        unsandboxedCommands: ["git status *"],
      },
      "config",
    ),
    {
      denyRead: [".env"],
      network: {
        mode: "deny",
        allowedDomains: ["example.com", "*.example.com"],
        allowedPorts: [443],
      },
      unsandboxedCommands: ["git status *"],
    },
  );
});

test("trusted project config tightens a valid global layer", async () => {
  const root = await mkdtemp(join(tmpdir(), "bwubblewap-config-"));
  const globalPath = join(root, "global.json");
  const projectPath = join(root, ".pi", "extensions", "bwubblewap.json");
  const globalDeny = join(root, "global-secret");
  const projectDeny = join(root, "project-secret");
  await mkdir(join(root, ".pi", "extensions"), { recursive: true });
  await writeFile(globalDeny, "sentinel");
  await writeFile(projectDeny, "sentinel");
  await writeFile(
    globalPath,
    JSON.stringify({ denyRead: [globalDeny], unsandboxedCommands: ["git status *"] }),
  );
  await writeFile(
    projectPath,
    JSON.stringify({ denyRead: [projectDeny], unsandboxedCommands: ["git push *"] }),
  );
  const resources = await createSessionResources();
  try {
    const trusted = await buildEffectivePolicy(
      { cwd: root, isProjectTrusted: () => true },
      resources,
      { globalPath, projectPath, materializeHomeDeny: false },
    );
    assert.equal(
      trusted.denyRead.some((rule) => rule.path === globalDeny),
      true,
    );
    assert.equal(
      trusted.denyRead.some((rule) => rule.path === projectDeny),
      true,
    );
    assert.deepEqual(trusted.unsandboxedCommands, ["git status *"]);
    assert.equal(
      trusted.warnings.some((warning) => warning.includes("project unsandboxedCommands ignored")),
      true,
    );

    const untrusted = await buildEffectivePolicy(
      { cwd: root, isProjectTrusted: () => false },
      resources,
      { globalPath, projectPath, materializeHomeDeny: false },
    );
    assert.equal(
      untrusted.denyRead.some((rule) => rule.path === projectDeny),
      false,
    );
    assert.equal(
      untrusted.warnings.some((warning) => warning.includes("not trusted")),
      true,
    );
    assert.equal(untrusted.configSources.includes(projectPath), false);

    await writeFile(projectPath, "{");
    const malformedProject = await buildEffectivePolicy(
      { cwd: root, isProjectTrusted: () => true },
      resources,
      { globalPath, projectPath, materializeHomeDeny: false },
    );
    assert.equal(malformedProject.configValid, false);
    assert.equal(
      malformedProject.denyRead.some((rule) => rule.path === globalDeny),
      true,
    );
    assert.deepEqual(malformedProject.unsandboxedCommands, []);
  } finally {
    await cleanupSessionResources(resources);
  }
});
