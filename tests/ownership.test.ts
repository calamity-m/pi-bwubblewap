import assert from "node:assert/strict";
import test from "node:test";
import register from "../src/register.ts";

test("ownership backstop passes owned tools and blocks foreign retained schemas", async () => {
  const tools: Array<{ name: string; parameters: object }> = [];
  const handlers = new Map<string, Function[]>();
  const flags = new Map<string, unknown>();
  const pi = {
    registerTool(definition: { name: string; parameters: object }) {
      tools.push(definition);
    },
    registerFlag(name: string, definition: { default?: unknown }) {
      flags.set(name, definition.default);
    },
    registerCommand() {},
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
  const gate = handlers.get("tool_call")?.[0];
  assert.ok(gate);
  assert.equal((await gate({ toolName: "bash" }, {}))?.block, undefined);
  tools[0] = { name: "bash", parameters: {} };
  const blocked = await gate({ toolName: "bash" }, {});
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason, /does not own active bash/);
});
