import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const helper = new URL("../src/backend/fs-helper.mjs", import.meta.url);

async function run(
  action: string,
  path: string,
  input?: Buffer,
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const child = spawn(process.execPath, [helper.pathname, action, path], {
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk) => stdout.push(chunk));
  child.stderr?.on("data", (chunk) => stderr.push(chunk));
  if (input) child.stdin?.end(input);
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() };
}

test("helper reads and writes binary bytes and reports stat/list JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "bwubblewap-helper-"));
  const file = join(root, "data.bin");
  const bytes = Buffer.from([0, 1, 2, 255]);
  await writeFile(file, bytes);
  assert.deepEqual((await run("read-r", file)).stdout, bytes);
  assert.equal((await run("write", file, Buffer.from("next"))).code, 0);
  assert.deepEqual(await readFile(file), Buffer.from("next"));
  assert.deepEqual(JSON.parse((await run("stat", root)).stdout.toString()), { isDirectory: true });
  assert.deepEqual(JSON.parse((await run("list", root)).stdout.toString()), [
    { name: "data.bin", isDirectory: false },
  ]);
});
