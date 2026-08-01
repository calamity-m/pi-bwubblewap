import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { matchesDomain, isAllowedTarget } from "../src/proxy/filter.ts";
import { ProxyManager } from "../src/proxy/server.ts";

test("domain filter handles exact and wildcard boundaries", () => {
  assert.equal(matchesDomain("github.com", "github.com"), true);
  assert.equal(matchesDomain("api.github.com", "*.github.com"), true);
  assert.equal(matchesDomain("github.com", "*.github.com"), false);
  assert.equal(matchesDomain("evilgithub.com", "*.github.com"), false);
  assert.equal(isAllowedTarget("github.com", 443, ["github.com"], [443]), true);
  assert.equal(isAllowedTarget("github.com", 22, ["github.com"], [443]), false);
});

test("proxy authenticates calls and names blocked hosts", async () => {
  const root = await mkdtemp(join(tmpdir(), "bwubblewap-proxy-"));
  const manager = new ProxyManager({
    socketPath: join(root, "proxy.sock"),
    allowedDomains: ["allowed.test"],
    allowedPorts: [80],
  });
  await manager.start();
  const { token } = manager.registerCall();
  const request = (auth: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(manager.socketPath(), () => {
        socket.write(
          `CONNECT blocked.test:80 HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
        );
      });
      let output = "";
      socket.on("data", (chunk) => {
        output += chunk;
      });
      socket.on("close", () => resolve(output));
    });
  try {
    assert.match(await request(Buffer.from(`bw:${token}`).toString("base64")), /403/);
    assert.deepEqual(manager.blockedHosts(token), ["blocked.test:80"]);
    assert.match(await request("invalid"), /407/);
    const second = manager.registerCall();
    const secondAuth = Buffer.from(`bw:${second.token}`).toString("base64");
    const secondRequest = new Promise<string>((resolve) => {
      const socket = connect(manager.socketPath(), () => {
        socket.write(
          `CONNECT other.test:80 HTTP/1.1\r\nProxy-Authorization: Basic ${secondAuth}\r\n\r\n`,
        );
      });
      let output = "";
      socket.on("data", (chunk) => {
        output += chunk;
      });
      socket.on("close", () => resolve(output));
    });
    assert.match(await secondRequest, /403/);
    assert.deepEqual(manager.blockedHosts(token), ["blocked.test:80"]);
    assert.deepEqual(manager.blockedHosts(second.token), ["other.test:80"]);
    assert.equal(manager.blockedHosts(token).includes(token), false);
    manager.revokeCall(token);
    assert.match(await request(Buffer.from(`bw:${token}`).toString("base64")), /407/);
    const oversized = new Promise<string>((resolve) => {
      const socket = connect(manager.socketPath(), () => socket.write("X".repeat(33 * 1024)));
      let output = "";
      socket.on("data", (chunk) => {
        output += chunk;
      });
      socket.on("close", () => resolve(output));
    });
    assert.match(await oversized, /400/);
  } finally {
    await manager.close();
    assert.equal(manager.activeTokenCount(), 0);
  }
});

test("proxy tunnels allowed CONNECT bytes without interception", async () => {
  const origin = createServer((socket) => socket.on("data", (chunk) => socket.end(chunk)));
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const address = origin.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "bwubblewap-connect-"));
  const manager = new ProxyManager({
    socketPath: join(root, "proxy.sock"),
    allowedDomains: ["localhost"],
    allowedPorts: [address.port],
  });
  await manager.start();
  const call = manager.registerCall();
  try {
    const auth = Buffer.from(`bw:${call.token}`).toString("base64");
    const output = await new Promise<string>((resolve) => {
      const socket = connect(manager.socketPath(), () => {
        socket.write(
          `CONNECT localhost:${address.port} HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\nopaque-origin-bytes`,
        );
      });
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk;
      });
      socket.on("close", () => resolve(received));
    });
    assert.match(output, /200 Connection Established/);
    assert.match(output, /opaque-origin-bytes/);
  } finally {
    await manager.close();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
});

test("proxy rewrites absolute HTTP requests to origin form", async () => {
  let requestLine = "";
  const upstream = createServer((socket) => {
    socket.once("data", (data) => {
      requestLine = data.toString().split("\r\n")[0] ?? "";
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const root = await mkdtemp(join(tmpdir(), "bwubblewap-proxy-http-"));
  const manager = new ProxyManager({
    socketPath: join(root, "proxy.sock"),
    allowedDomains: ["127.0.0.1"],
    allowedPorts: [address.port],
  });
  await manager.start();
  const { token } = manager.registerCall();
  try {
    const response = await new Promise<string>((resolve) => {
      const socket = connect(manager.socketPath(), () => {
        const auth = Buffer.from(`bw:${token}`).toString("base64");
        socket.write(
          `GET http://127.0.0.1:${address.port}/path?q=1 HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
        );
      });
      let output = "";
      socket.on("data", (chunk) => {
        output += chunk;
      });
      socket.on("close", () => resolve(output));
    });
    assert.equal(requestLine, "GET /path?q=1 HTTP/1.1");
    assert.match(response, /\r\n\r\nok$/);
  } finally {
    await manager.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
