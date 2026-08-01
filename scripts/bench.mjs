import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { BwrapBackend, runWrapped } from "../src/backend/bwrap.ts";
import { createSessionResources, cleanupSessionResources } from "../src/backend/resources.ts";
import { buildDefaultPolicy } from "../src/policy/default-policy.ts";
import { ProxyManager } from "../src/proxy/server.ts";

const RUNS = 20;
const WARMUP = 3;
const resources = await createSessionResources();
resources.proxySocket = join(resources.sessionDir, "proxy.sock");
const proxy = new ProxyManager({
  socketPath: resources.proxySocket,
  allowedDomains: [],
  allowedPorts: [80, 443],
});
await proxy.start();
const policy = await buildDefaultPolicy(process.cwd(), resources, { materializeHomeDeny: true });
const backend = new BwrapBackend();

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
async function measure(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}
function stock() {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/true", [], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`true exited ${code}`)),
    );
  });
}
async function off() {
  const result = await runWrapped(
    backend.wrap(["/bin/true"], policy, resources, { network: "off" }),
    { network: "off" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
async function deny() {
  const call = proxy.registerCall();
  const command = `${shellQuote(resources.socatPath)} TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${shellQuote(resources.proxySocket)} >/dev/null 2>&1 & p=$!; trap 'kill "$p" 2>/dev/null' EXIT; sleep 0.01; true`;
  try {
    const result = await runWrapped(
      backend.wrap(["/bin/bash", "-c", command], policy, resources, {
        network: "deny",
        proxyToken: call.token,
      }),
      { network: "deny" },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  } finally {
    proxy.revokeCall(call.token);
  }
}

try {
  for (let i = 0; i < WARMUP; i++) {
    await stock();
    await off();
    await deny();
  }
  const samples = { stock: [], off: [], deny: [] };
  for (let i = 0; i < RUNS; i++) {
    samples.stock.push(await measure(stock));
    samples.off.push(await measure(off));
    samples.deny.push(await measure(deny));
  }
  const base = percentile(samples.stock, 0.5);
  for (const name of ["stock", "off", "deny"]) {
    const p50 = percentile(samples[name], 0.5);
    const p95 = percentile(samples[name], 0.95);
    console.log(
      `${name}: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms delta-p50=${(p50 - base).toFixed(2)}ms`,
    );
  }
  const overhead = percentile(samples.deny, 0.5) - base;
  console.log(
    `NFR-1: ${overhead <= 100 ? "PASS" : "FAIL"} (${overhead.toFixed(2)}ms median default-network overhead)`,
  );
  if (overhead > 100) process.exitCode = 1;
} finally {
  await proxy.close();
  await cleanupSessionResources(resources);
}
