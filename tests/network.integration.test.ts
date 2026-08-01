import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { ProxyManager } from "../src/proxy/server.ts";
import { createSessionResources, cleanupSessionResources } from "../src/backend/resources.ts";
import type { EffectivePolicy } from "../src/policy/types.ts";
import { createSessionRuntime } from "../src/runtime.ts";
import { createSandboxedBashDefinition } from "../src/tools/bash.ts";

const canRun =
  process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/socat");
const skipReason = canRun ? undefined : "requires Linux bubblewrap, socat, and curl";

test(
  "sandboxed bash routes blocked HTTP through the authenticated proxy",
  { skip: skipReason },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bwubblewap-network-"));
    const resources = await createSessionResources();
    resources.proxySocket = join(resources.sessionDir, "proxy.sock");
    const origin = createServer((_request, response) => response.end("allowed-origin-ok"));
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const originAddress = origin.address();
    assert.ok(originAddress && typeof originAddress === "object");
    const proxy = new ProxyManager({
      socketPath: resources.proxySocket,
      allowedDomains: ["localhost"],
      allowedPorts: [80, 443, originAddress.port],
    });
    await proxy.start();
    const runtime = createSessionRuntime();
    const rule = (path: string) => ({
      configured: path,
      path,
      kind: "dir" as const,
      materialized: false,
    });
    const fullNetworkCommand = `curl -sS http://localhost:${originAddress.port}/`;
    const policy: EffectivePolicy = Object.freeze({
      backend: "bwrap",
      denyRead: Object.freeze([]),
      denyWrite: Object.freeze([]),
      allowWrite: Object.freeze([rule(root), rule(resources.scratchDir), rule("/tmp")]),
      network: "deny",
      allowedDomains: Object.freeze(["localhost"]),
      allowedPorts: Object.freeze([80, 443, originAddress.port]),
      unsandboxedCommands: Object.freeze([fullNetworkCommand]),
      cwd: root,
      warnings: Object.freeze([]),
      configSources: Object.freeze([]),
      configValid: true,
    });
    runtime.proxyManager = proxy;
    runtime.mode = {
      kind: "active",
      policy,
      resources,
      probe: { ok: true, selectiveNetworkChecked: true },
    };
    const tool = createSandboxedBashDefinition(root, () => runtime) as never as {
      execute: Function;
    };
    const ctx = {
      model: undefined,
      thinkingLevel: undefined,
      hasUI: false,
      sessionManager: { getSessionId: () => "network-test", getSessionFile: () => undefined },
    };
    try {
      const result = await tool.execute(
        "network",
        { command: "curl -sS http://blocked.test/" },
        undefined,
        undefined,
        ctx,
      );
      assert.match(result.content[0].text, /blocked\.test/);
      const allowed = await tool.execute(
        "network-allowed",
        { command: `curl -sS http://localhost:${originAddress.port}/` },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(allowed.content[0].text, "allowed-origin-ok");
      const fullNetwork = await tool.execute(
        "network-full",
        { command: fullNetworkCommand, network: true },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(fullNetwork.content[0].text, "allowed-origin-ok");
      assert.equal(runtime.counters.autoApproved, 1);
      const envResult = await tool.execute(
        "network-env",
        {
          command:
            'case "$HTTPS_PROXY" in http://bw:*@127.0.0.1:3128) ;; *) exit 9 ;; esac; test -z "${NO_PROXY-}"; printf proxy-env-ok',
        },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(envResult.content[0].text, "proxy-env-ok");
      await assert.rejects(
        tool.execute(
          "raw-socket",
          { command: "timeout 2 bash -c 'echo probe >/dev/tcp/1.1.1.1/443'" },
          undefined,
          undefined,
          ctx,
        ),
      );
      assert.equal(proxy.activeTokenCount(), 0);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => origin.close(() => resolve()));
      await cleanupSessionResources(resources);
    }
  },
);
