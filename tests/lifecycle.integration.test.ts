import assert from "node:assert/strict";
import test from "node:test";
import register from "../src/register.ts";

const canRun = process.platform === "linux";

test(
  "factory wrappers become executable only after successful session startup",
  { skip: canRun ? undefined : "requires Linux" },
  async () => {
    const tools: Array<{ name: string; parameters: object; execute: Function }> = [];
    const handlers = new Map<string, Function[]>();
    const commands = new Map<string, { handler: Function }>();
    const flags = new Map<string, unknown>();
    const pi = {
      registerTool(definition: { name: string; parameters: object; execute: Function }) {
        tools.push(definition);
      },
      registerFlag(name: string, definition: { default?: unknown }) {
        flags.set(name, definition.default);
      },
      registerCommand(name: string, command: { handler: Function }) {
        commands.set(name, command);
      },
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      getFlag(name: string) {
        return flags.get(name);
      },
      getAllTools() {
        return tools;
      },
    };
    register(pi as never);
    const bash = tools.find((tool) => tool.name === "bash");
    assert.ok(bash);
    const context = {
      cwd: process.cwd(),
      hasUI: false,
      isProjectTrusted: () => true,
      model: undefined,
      thinkingLevel: undefined,
      sessionManager: { getSessionId: () => "lifecycle-test", getSessionFile: () => undefined },
      ui: {
        notify() {},
        setStatus() {},
        select: async () => "Allow once",
      },
      reload: async () => undefined,
    };
    await assert.rejects(
      bash.execute("before", { command: "true" }, undefined, undefined, context),
      /escalation denied/,
    );
    context.hasUI = true;
    await handlers.get("session_start")?.[0]?.({}, context);
    try {
      const result = await bash.execute(
        "after",
        { command: "printf lifecycle-ok" },
        undefined,
        undefined,
        context,
      );
      assert.equal(result.content[0].text, "lifecycle-ok");
      const sandboxCommand = commands.get("sandbox");
      assert.ok(sandboxCommand);
      await sandboxCommand.handler("disable", context);
      const disabled = await bash.execute(
        "disabled",
        { command: "printf disabled-ok" },
        undefined,
        undefined,
        context,
      );
      assert.equal(disabled.content[0].text, "disabled-ok");
      await sandboxCommand.handler("enable", context);
      const enabled = await bash.execute(
        "enabled",
        { command: "printf enabled-ok" },
        undefined,
        undefined,
        context,
      );
      assert.equal(enabled.content[0].text, "enabled-ok");
      const childStarted = Date.now();
      const longRunning = assert.rejects(
        bash.execute("reload-child", { command: "sleep 30" }, undefined, undefined, context),
        /Command terminated without an exit code/,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await sandboxCommand.handler("reload", context);
      await longRunning;
      assert.equal(Date.now() - childStarted < 2_000, true);
      context.hasUI = false;
      await assert.rejects(
        bash.execute("during-reload", { command: "true" }, undefined, undefined, context),
        /escalation denied/,
      );
    } finally {
      await handlers.get("session_shutdown")?.[0]?.({}, context);
    }
  },
);
