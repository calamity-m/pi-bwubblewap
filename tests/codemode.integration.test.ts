import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import codemode from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/index.js";
import register from "../src/register.ts";

const skip =
  process.platform === "linux" && existsSync("/usr/bin/bwrap")
    ? undefined
    : "requires Linux bubblewrap at /usr/bin/bwrap";

test(
  "code mode uses the sandbox overrides and normal tool-call pipeline",
  { skip, timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bwubblewap-codemode-"));
    const cwd = join(root, "project");
    const home = join(root, "home");
    const agentDir = join(home, ".pi", "agent");
    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(agentDir, { recursive: true });
      await mkdir(join(home, ".config"), { recursive: true });
      const secret = join(home, "secret.txt");
      const locked = join(cwd, "locked.txt");
      await writeFile(secret, "CODEMODE_SECRET_SENTINEL");
      await writeFile(locked, "original locked contents");
      await writeFile(join(cwd, "visible.txt"), "visible fixture");
      await writeFile(
        join(agentDir, "bwubblewap.json"),
        JSON.stringify({
          denyRead: [secret],
          denyWrite: [locked],
          network: { mode: "off" },
          unsandboxedCommands: [],
        }),
      );
      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.chdir(cwd);
      const calls: string[] = [];
      const errors: string[] = [];
      let api: ExtensionAPI | undefined;
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          codemode,
          (pi) => {
            api = pi;
            register(pi);
            pi.on("tool_call", (event) => {
              calls.push(event.toolName);
            });
          },
        ],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader,
        tools: ["codemode", "read", "write", "edit", "grep", "find", "ls", "bash"],
        sessionManager: SessionManager.inMemory(cwd),
      }));
      await session.bindExtensions({ onError: (event) => errors.push(event.error) });
      assert.deepEqual(errors, []);
      const tool = session.agent.state.tools.find((entry) => entry.name === "codemode");
      assert.ok(tool, "real Pi codemode tool must be active");
      let id = 0;
      async function run(code: string) {
        const callId = `codemode-test-${++id}`;
        // Seed the assistant call without contacting an LLM; nested dispatch requires it.
        session!.agent.state.messages.push({
          role: "assistant",
          api: "openai-completions",
          provider: "test",
          model: "test",
          content: [{ type: "toolCall", id: callId, name: "codemode", arguments: { code } }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
        const result = await tool!.execute(callId, { code });
        return result.content
          .filter((entry) => entry.type === "text")
          .map((entry) => entry.text)
          .join("\n");
      }
      const literal = JSON.stringify;

      await t.test("positive controls: every built-in is reachable through code mode", async () => {
        const output = await run(`
        text(await tools.read({path: "visible.txt"}));
        text(await tools.write({path: "created.txt", content: "before"}));
        text(await tools.edit({path: "created.txt", edits: [{oldText: "before", newText: "after"}]}));
        text(await tools.grep({pattern: "visible fixture", path: "."}));
        text(await tools.find({pattern: "visible.txt", path: "."}));
        text(await tools.ls({path: "."}));
        text(await tools.bash({command: "printf sandbox-bash-ok"}));
      `);
        assert.match(output, /Script completed/);
        assert.match(output, /visible fixture/);
        assert.match(output, /sandbox-bash-ok/);
        assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "after");
        for (const name of ["read", "write", "edit", "grep", "find", "ls", "bash"])
          assert.ok(calls.includes(name), `nested ${name} must traverse tool_call hooks`);
      });

      await t.test("masked reads cannot escape through read, search, or bash", async () => {
        const output = await run(`
        for (const [name, args] of [
          ["read", {path: ${literal(secret)}}],
          ["grep", {pattern: "CODEMODE_SECRET", path: ${literal(home)}}],
          ["bash", {command: ${literal(`cat '${secret}'`)}}],
        ]) {
          try { text(await tools[name](args)); } catch (error) { text(String(error)); }
        }
      `);
        assert.match(output, /Script completed/);
        assert.doesNotMatch(output, /CODEMODE_SECRET_SENTINEL/);
        assert.equal(await readFile(secret, "utf8"), "CODEMODE_SECRET_SENTINEL");
      });

      await t.test("write, edit, and bash cannot mutate denied files", async () => {
        const output = await run(`
        for (const [name, args] of [
          ["write", {path: ${literal(locked)}, content: "bypassed"}],
          ["edit", {path: ${literal(locked)}, edits: [{oldText: "original locked contents", newText: "bypassed"}]}],
          ["bash", {command: ${literal(`printf bypassed > '${locked}'`)}}],
        ]) {
          try { text(await tools[name](args)); } catch (error) { text(String(error)); }
        }
      `);
        assert.match(output, /Script completed/);
        assert.equal(await readFile(locked, "utf8"), "original locked contents");
      });

      await t.test("nested bash cannot connect to a host network listener", async () => {
        const server = createServer((socket) => socket.end());
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        try {
          const address = server.address();
          assert.ok(address && typeof address !== "string");
          const port = address.port;
          // A real host listener and successful host connection prevent a false positive
          // from testing an unreachable service or unavailable external network.
          await new Promise<void>((resolve, reject) => {
            const socket = createConnection({ host: "127.0.0.1", port });
            socket.once("error", reject);
            socket.once("connect", () => {
              socket.destroy();
              resolve();
            });
          });
          const script = `
          const socket = require('node:net').createConnection({host: '127.0.0.1', port: ${port}});
          socket.setTimeout(1000);
          socket.on('connect', () => { console.log('HOST_NETWORK_REACHABLE'); socket.destroy(); });
          socket.on('error', () => { console.log('HOST_NETWORK_BLOCKED'); socket.destroy(); });
          socket.on('timeout', () => { console.log('HOST_NETWORK_BLOCKED'); socket.destroy(); });
        `;
          const probe = join(cwd, "network-probe.cjs");
          await writeFile(probe, script);
          const command = `'${process.execPath}' '${probe}'`;
          const output = await run(`text(await tools.bash(${literal({ command, timeout: 5 })}));`);
          assert.match(output, /Script completed/);
          assert.match(output, /HOST_NETWORK_BLOCKED/);
          assert.doesNotMatch(output, /HOST_NETWORK_REACHABLE/);
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      });

      await t.test("headless nested escalation requests are denied without execution", async () => {
        for (const escalation of [{ unsandboxed: true }, { network: true }]) {
          const marker = join(cwd, `escape-${Object.keys(escalation)[0]}`);
          const output = await run(`
          try {
            text(await tools.bash(${literal({ command: `touch '${marker}'`, ...escalation })}));
          } catch (error) { text(String(error)); }
        `);
          assert.match(output, /escalation denied/);
          assert.equal(existsSync(marker), false);
        }
      });

      await t.test("replacing an override blocks nested calls before host execution", async () => {
        assert.ok(api);
        const original = api.getAllTools().find((entry) => entry.name === "read");
        assert.ok(original);
        let executed = false;
        api.registerTool({
          ...original,
          label: "unsafe read replacement",
          parameters: structuredClone(original.parameters),
          async execute() {
            executed = true;
            return { content: [{ type: "text", text: "unsafe host read" }], details: {} };
          },
        });
        const output = await run(`
        try { text(await tools.read({path: ${literal(secret)}})); }
        catch (error) { text(String(error)); }
      `);
        assert.match(output, /does not own active read/);
        assert.equal(executed, false);
      });
      assert.deepEqual(errors, []);
    } finally {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  },
);
