import assert from "node:assert/strict";
import test from "node:test";
import register from "../src/register.ts";

interface FakePi {
  tools: Array<{ name: string }>;
  handlers: Map<string, Function[]>;
  flags: Map<string, unknown>;
  registerTool(definition: { name: string }): void;
  registerFlag(name: string, definition: { default?: unknown }): void;
  registerCommand(): void;
  on(name: string, handler: Function): void;
  getFlag(name: string): unknown;
}

function fakePi(): FakePi {
  const tools: Array<{ name: string }> = [];
  const handlers = new Map<string, Function[]>();
  const flags = new Map<string, unknown>();
  return {
    tools,
    handlers,
    flags,
    registerTool(definition) {
      tools.push(definition);
    },
    registerFlag(name, definition) {
      flags.set(name, definition.default);
    },
    registerCommand() {},
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getFlag(name) {
      return flags.get(name);
    },
  };
}

test("factory registers all seven wrappers before session_start", () => {
  const pi = fakePi();
  register(pi as never);
  assert.deepEqual(
    pi.tools.map((tool) => tool.name),
    ["bash", "read", "write", "edit", "grep", "find", "ls"],
  );
  assert.equal(pi.handlers.has("session_start"), true);
  assert.equal(pi.handlers.has("session_shutdown"), true);
});
