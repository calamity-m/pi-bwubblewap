import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const [, , action, target] = process.argv;

async function main() {
  if (!action || !target) throw new Error("usage: fs-helper.mjs ACTION PATH");
  switch (action) {
    case "read-r":
      await access(target, constants.R_OK);
      process.stdout.write(await readFile(target));
      return;
    case "read-rw":
      await access(target, constants.R_OK | constants.W_OK);
      process.stdout.write(await readFile(target));
      return;
    case "write":
      await writeFile(target, await readStdin());
      return;
    case "mkdir":
      await mkdir(target, { recursive: true });
      return;
    case "stat": {
      const info = await stat(target);
      process.stdout.write(JSON.stringify({ isDirectory: info.isDirectory() }));
      return;
    }
    case "list": {
      const entries = await readdir(target, { withFileTypes: true });
      process.stdout.write(
        JSON.stringify(
          entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })),
        ),
      );
      return;
    }
    default:
      throw new Error(`unknown helper action: ${action}`);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
