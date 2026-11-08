import assert from "node:assert/strict";
import test from "node:test";
import { requestApproval } from "../src/approval.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";

type ApprovalFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];

function terminalContext(inspect: (component: Component, terminal: { rows: number }) => void) {
  return {
    hasUI: true,
    mode: "tui",
    ui: {
      custom: async (factory: ApprovalFactory) => {
        let result: unknown;
        const terminal = { rows: 24 };
        const component = await factory(
          { terminal, requestRender() {} } as never,
          { fg: (_color: string, text: string) => text } as never,
          {
            matches: (data: string, action: string) =>
              action === "tui.select.cancel" && data === "\x1b",
          } as never,
          (value) => {
            result = value;
          },
        );
        inspect(component, terminal);
        return result;
      },
    },
  } as never;
}

function context(choices: string[], active = true) {
  let concurrent = 0;
  let maximum = 0;
  return {
    get concurrent() {
      return concurrent;
    },
    get maximum() {
      return maximum;
    },
    ctx: {
      hasUI: active,
      ui: {
        select: async () => {
          concurrent++;
          maximum = Math.max(maximum, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 5));
          concurrent--;
          return choices.shift();
        },
      },
    } as never,
  };
}

test("large approval content keeps choices visible while paging and resizing", async () => {
  for (const command of ["界".repeat(50_000) + "THE_END", "line\n".repeat(10_000) + "THE_END"]) {
    const ctx = terminalContext((component, terminal) => {
      for (const [width, height] of [
        [80, 24],
        [20, 12],
        [40, 18],
      ]) {
        terminal.rows = height!;
        component.invalidate();
        const lines = component.render(width!);
        assert.ok(lines.length <= height! - 3);
        assert.ok(lines.every((line) => visibleWidth(line) <= width!));
        assert.ok(lines.some((line) => line.includes("Deny")));
        assert.ok(lines.some((line) => line.includes("Allow once")));
      }
      component.handleInput?.("\x1b[F"); // End
      assert.ok(component.render(40).some((line) => line.includes("THE_END")));
      component.handleInput?.("\x1b[H"); // Home
      assert.ok(component.render(40).some((line) => line.includes("Command lines 1-")));
      component.handleInput?.("\x1b[6~"); // PageDown
      assert.ok(!component.render(40).some((line) => line.includes("Command lines 1-")));
      component.handleInput?.("\x1b[5~"); // PageUp
      assert.ok(component.render(40).some((line) => line.includes("Command lines 1-")));
      component.handleInput?.("\r"); // Deny is selected by default
    });
    assert.equal(await requestApproval(ctx, "host execution", command), false);
  }
});

test("terminal approval only allows an explicit Allow once selection", async () => {
  for (const [keys, expected] of [
    [[], false],
    [["\x1b"], false],
    [["\r"], false],
    [["\x1b[B", "\r"], true],
  ] as const) {
    const ctx = terminalContext((component) => {
      component.render(80);
      for (const key of keys) component.handleInput?.(key);
    });
    assert.equal(await requestApproval(ctx, "network access", "curl example.com"), expected);
  }
});

test("command control characters cannot change the approval display", async () => {
  const ctx = terminalContext((component) => {
    const lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("\\x1b[2J\\x0d")));
    assert.ok(lines.every((line) => !line.includes("\x1b")));
  });
  assert.equal(await requestApproval(ctx, "host execution", "printf '\x1b[2J\r'"), false);
});

test("headless approval denies", async () => {
  const result = await requestApproval({ hasUI: false } as never, "host execution", "true");
  assert.equal(result, false);
});

test("RPC approval receives the full command", async () => {
  const command = "echo line\n".repeat(10_000);
  const ctx = {
    hasUI: true,
    mode: "rpc",
    ui: {
      select: async (title: string, choices: string[]) => {
        assert.equal(title, `Allow host execution for command: ${command}?`);
        assert.deepEqual(choices, ["Deny", "Allow once"]);
        return "Allow once";
      },
    },
  } as never;
  assert.equal(await requestApproval(ctx, "host execution", command), true);
});

test("a failed dialog releases the approval queue", async () => {
  const ctx = terminalContext(() => {
    throw new Error("dialog failed");
  });
  await assert.rejects(requestApproval(ctx, "host execution", "one"), /dialog failed/);
  const fixture = context(["Allow once"]);
  assert.equal(await requestApproval(fixture.ctx, "host execution", "two"), true);
});

test("approval prompts are serialized", async () => {
  const fixture = context(["Allow once", "Deny"]);
  const results = await Promise.all([
    requestApproval(fixture.ctx, "host execution", "one"),
    requestApproval(fixture.ctx, "host execution", "two"),
  ]);
  assert.deepEqual(results, [true, false]);
  assert.equal(fixture.maximum, 1);
});
