import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import test from "node:test";
import { runWrapped } from "../src/backend/bwrap.ts";

const mounts = ["/mnt/c", "/mnt/d", "/mnt/wsl", "/run/user/1000"] as const;
const bwrapArgs = (target: string) => [
  "/usr/bin/bwrap",
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--unshare-pid",
  "--die-with-parent",
  "--",
  "/bin/sh",
  "-c",
  `printf x > ${JSON.stringify(target)}`,
];

for (const mount of mounts) {
  test(
    `host mount ${mount} stays read-only inside the sandbox`,
    { skip: !existsSync(mount) ? `absent mount: ${mount}` : undefined },
    async () => {
      const target = `${mount}/pi-bwubblewap-mount-${process.pid}`;
      const result = await runWrapped(bwrapArgs(target), { network: "off" });
      assert.notEqual(result.exitCode, 0);
      assert.equal(existsSync(target), false);
    },
  );
}

test("private /dev/shm does not write through to the host", async () => {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
  const target = `/dev/shm/pi-bwubblewap-${process.pid}`;
  await unlink(target).catch(() => undefined);
  const result = await runWrapped(
    [
      "/usr/bin/bwrap",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--unshare-pid",
      "--die-with-parent",
      "--",
      "/bin/sh",
      "-c",
      `printf x > ${JSON.stringify(target)}`,
    ],
    { network: "off" },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(target), false);
});
