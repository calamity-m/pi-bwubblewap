import { randomBytes } from "node:crypto";
import { createServer, connect, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { isAllowedTarget, normalizeHost } from "./filter.ts";

export const MAX_PROXY_HEADER_BYTES = 8 * 1024;
export const PROXY_HEADER_TIMEOUT_MS = 5000;
export const PROXY_CONNECT_TIMEOUT_MS = 10000;

type Dial = (host: string, port: number) => Socket;

interface CallState {
  blockedHosts: Set<string>;
}

export interface ProxyManagerOptions {
  socketPath: string;
  allowedDomains: readonly string[];
  allowedPorts: readonly number[];
  dial?: Dial;
}

export class ProxyManager {
  private readonly options: ProxyManagerOptions;
  private readonly server: Server;
  private readonly calls = new Map<string, CallState>();
  private readonly connections = new Set<Socket>();
  private readonly dial: Dial;
  private alive = false;

  constructor(options: ProxyManagerOptions) {
    this.options = options;
    this.dial = options.dial ?? ((host, port) => connect({ host, port }));
    this.server = createServer((socket) => void this.handle(socket));
  }

  async start(): Promise<void> {
    await unlink(this.options.socketPath).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        this.alive = true;
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.socketPath);
    });
  }

  registerCall(): { token: string; blockedHosts: readonly string[] } {
    let token: string;
    do token = randomBytes(32).toString("hex");
    while (this.calls.has(token));
    this.calls.set(token, { blockedHosts: new Set() });
    return { token, blockedHosts: [] };
  }

  revokeCall(token: string): void {
    this.calls.delete(token);
  }

  blockedHosts(token: string): string[] {
    return [...(this.calls.get(token)?.blockedHosts ?? [])];
  }
  isAlive(): boolean {
    return this.alive;
  }
  activeTokenCount(): number {
    return this.calls.size;
  }
  socketPath(): string {
    return this.options.socketPath;
  }

  async close(): Promise<void> {
    this.alive = false;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    await unlink(this.options.socketPath).catch(() => undefined);
    this.calls.clear();
  }

  private async handle(socket: Socket): Promise<void> {
    this.connections.add(socket);
    socket.once("close", () => this.connections.delete(socket));
    socket.setTimeout(PROXY_HEADER_TIMEOUT_MS, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_PROXY_HEADER_BYTES) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      socket.pause();
      void this.dispatch(
        socket,
        buffer.subarray(0, end + 4).toString("latin1"),
        buffer.subarray(end + 4),
      );
    };
    socket.on("data", onData);
  }

  private async dispatch(socket: Socket, header: string, extra: Buffer): Promise<void> {
    const lines = header.split("\r\n");
    const request = lines.shift() ?? "";
    const headers = new Map<string, string>();
    for (const line of lines) {
      if (!line) continue;
      const separator = line.indexOf(":");
      if (separator <= 0) return this.respond(socket, 400, "malformed headers");
      const name = line.slice(0, separator).toLowerCase();
      if (headers.has(name)) return this.respond(socket, 400, "duplicate headers");
      headers.set(name, line.slice(separator + 1).trim());
    }
    const auth = headers.get("proxy-authorization");
    const token = this.parseToken(auth);
    const call = token ? this.calls.get(token) : undefined;
    if (!call) return this.respond(socket, 407, "proxy authentication required");
    const parts = request.split(" ");
    if (parts.length < 3) return this.respond(socket, 400, "malformed request target");
    const method = parts[0]!;
    const target = parts[1]!;
    let host: string;
    let port: number;
    let outbound: Buffer = extra;
    let connectMode = method.toUpperCase() === "CONNECT";
    if (connectMode) {
      const parsed = this.parseAuthority(target);
      if (!parsed) return this.respond(socket, 400, "malformed CONNECT target");
      host = parsed.host;
      port = parsed.port;
    } else {
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        return this.respond(socket, 400, "absolute URI required");
      }
      if (url.protocol !== "http:") return this.respond(socket, 400, "HTTPS requires CONNECT");
      if (url.username || url.password || url.hash)
        return this.respond(socket, 400, "userinfo and fragments are not allowed");
      host = normalizeHost(url.hostname);
      port = Number(url.port || 80);
      const hostHeader = headers.get("host");
      if (hostHeader && normalizeHost(hostHeader.split(":")[0]!) !== host)
        return this.respond(socket, 400, "conflicting Host header");
      const path = `${url.pathname || "/"}${url.search}`;
      outbound = Buffer.concat([
        Buffer.from(`${method} ${path} ${parts[2]}\r\n`),
        Buffer.from(
          lines
            .filter(Boolean)
            .filter((line) => !line.toLowerCase().startsWith("proxy-authorization:"))
            .join("\r\n") + "\r\n\r\n",
          "latin1",
        ),
        extra,
      ]);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return this.respond(socket, 400, "invalid port");
    if (!isAllowedTarget(host, port, this.options.allowedDomains, this.options.allowedPorts)) {
      const blocked = `${host}:${port}`;
      call.blockedHosts.add(blocked);
      return this.respond(socket, 403, `blocked host ${host} port ${port}`);
    }
    let upstream: Socket;
    try {
      upstream = this.dial(host, port);
    } catch {
      return this.respond(socket, 502, "upstream connection failed");
    }
    this.connections.add(upstream);
    let connected = false;
    const timeout = setTimeout(() => {
      if (!connected) this.respond(socket, 502, "upstream connection timed out");
      upstream.destroy();
    }, PROXY_CONNECT_TIMEOUT_MS);
    upstream.once("error", () => {
      if (!connected) this.respond(socket, 502, "upstream connection failed");
      else socket.destroy();
    });
    upstream.once("connect", () => {
      connected = true;
      clearTimeout(timeout);
      this.connections.add(upstream);
      if (connectMode) {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (extra.byteLength) upstream.write(extra);
      } else {
        upstream.write(outbound);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
    });
    upstream.once("close", () => {
      clearTimeout(timeout);
      this.connections.delete(upstream);
    });
  }

  private parseToken(value: string | undefined): string | undefined {
    if (!value?.startsWith("Basic ")) return undefined;
    try {
      const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (decoded.slice(0, separator) !== "bw") return undefined;
      return decoded.slice(separator + 1);
    } catch {
      return undefined;
    }
  }

  private parseAuthority(value: string): { host: string; port: number } | undefined {
    if (value.startsWith("[")) {
      const end = value.indexOf("]:");
      if (end < 0) return undefined;
      return { host: normalizeHost(value.slice(1, end)), port: Number(value.slice(end + 2)) };
    }
    const separator = value.lastIndexOf(":");
    if (separator <= 0) return undefined;
    return {
      host: normalizeHost(value.slice(0, separator)),
      port: Number(value.slice(separator + 1)),
    };
  }

  private respond(socket: Socket, status: number, message: string): void {
    socket.end(
      `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : status === 407 ? "Proxy Authentication Required" : "Bad Request"}\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`,
    );
  }
}
