import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { runWrapped } from "../src/backend/bwrap.ts";

const skipReason =
  process.platform === "linux" && existsSync("/usr/bin/bwrap")
    ? undefined
    : "requires Linux bubblewrap at /usr/bin/bwrap";

test(
  "wrapped process abort and timeout terminate the child group",
  { skip: skipReason },
  async () => {
    const aborted = new AbortController();
    const abortPromise = runWrapped(
      [
        "/usr/bin/bwrap",
        "--ro-bind",
        "/",
        "/",
        "--unshare-pid",
        "--proc",
        "/proc",
        "--die-with-parent",
        "--",
        "/bin/sh",
        "-c",
        "sleep 30",
      ],
      { network: "off", signal: aborted.signal },
    );
    setTimeout(() => aborted.abort(), 40);
    await assert.rejects(
      abortPromise,
      (error: unknown) => error instanceof Error && error.message === "aborted",
    );

    await assert.rejects(
      runWrapped(
        [
          "/usr/bin/bwrap",
          "--ro-bind",
          "/",
          "/",
          "--unshare-pid",
          "--proc",
          "/proc",
          "--die-with-parent",
          "--",
          "/bin/sh",
          "-c",
          "sleep 30",
        ],
        { network: "off", timeoutSeconds: 0.04 },
      ),
      (error: unknown) => error instanceof Error && error.message === "timeout:0.04",
    );
  },
);

test("background descendants do not keep a wrapped call open", { skip: skipReason }, async () => {
  const result = await runWrapped(
    [
      "/usr/bin/bwrap",
      "--ro-bind",
      "/",
      "/",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--die-with-parent",
      "--",
      "/bin/sh",
      "-c",
      "sleep 30 & echo started",
    ],
    { network: "off" },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString().trim(), "started");
});
