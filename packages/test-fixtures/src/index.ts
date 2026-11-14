/**
 * Test-only infrastructure: a real UDP DNS server and a scriptable website server.
 * Used by integration and E2E tests so verification and SSRF code paths run
 * against genuine DNS packets and HTTP connections. Never imported by services.
 */
import { createSocket, type Socket } from "node:dgram";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------- DNS
export interface DnsZone {
  a: Map<string, string[] | (() => string[])>;
  aaaa: Map<string, string[]>;
  txt: Map<string, string[]>;
}

export interface FixtureDns {
  port: number;
  server: string; // "127.0.0.1:<port>"
  zone: DnsZone;
  setA(name: string, ips: string[] | (() => string[])): void;
  setTxt(name: string, values: string[]): void;
  clear(name: string): void;
  /** Names answered with SERVFAIL (simulates a broken/unavailable authoritative server). */
  servfail: Set<string>;
  queries: Array<{ name: string; type: number }>;
  close(): Promise<void>;
}

const TYPE_A = 1, TYPE_TXT = 16, TYPE_AAAA = 28;

export async function startDnsServer(port = 0, host = "127.0.0.1"): Promise<FixtureDns> {
  const zone: DnsZone = { a: new Map(), aaaa: new Map(), txt: new Map() };
  const queries: FixtureDns["queries"] = [];
  const servfail = new Set<string>();
  const sock: Socket = createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    try {
      const { id, name, qtype, questionEnd } = parseQuery(msg);
      queries.push({ name, type: qtype });
      const key = name.toLowerCase();
      const answers: Buffer[] = [];
      if (qtype === TYPE_A) {
        const v = zone.a.get(key);
        for (const ip of typeof v === "function" ? v() : v ?? []) answers.push(rr(TYPE_A, Buffer.from(ip.split(".").map(Number))));
      } else if (qtype === TYPE_AAAA) {
        for (const ip of zone.aaaa.get(key) ?? []) answers.push(rr(TYPE_AAAA, ipv6Bytes(ip)));
      } else if (qtype === TYPE_TXT) {
        for (const t of zone.txt.get(key) ?? []) answers.push(rr(TYPE_TXT, txtRdata(t)));
      }
      const known = zone.a.has(key) || zone.aaaa.has(key) || zone.txt.has(key);
      const rcode = servfail.has(key) ? 2 : known ? 0 : 3;
      if (rcode === 2) answers.length = 0;
      const header = Buffer.alloc(12);
      header.writeUInt16BE(id, 0);
      header.writeUInt16BE(0x8180 | rcode, 2); // response, RD+RA; rcode 3 NXDOMAIN, 2 SERVFAIL
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(answers.length, 6);
      sock.send(Buffer.concat([header, msg.subarray(12, questionEnd), ...answers]), rinfo.port, rinfo.address);
    } catch {
      /* malformed query: ignore */
    }
  });
  await new Promise<void>((r) => sock.bind(port, host, r));
  const p = (sock.address() as AddressInfo).port;
  return {
    port: p,
    server: `127.0.0.1:${p}`,
    zone,
    queries,
    servfail,
    setA: (n, ips) => void zone.a.set(n.toLowerCase(), ips),
    setTxt: (n, v) => void zone.txt.set(n.toLowerCase(), v),
    clear: (n) => { zone.a.delete(n.toLowerCase()); zone.aaaa.delete(n.toLowerCase()); zone.txt.delete(n.toLowerCase()); },
    close: () => new Promise<void>((r) => sock.close(() => r())),
  };
}

function parseQuery(msg: Buffer) {
  const id = msg.readUInt16BE(0);
  let off = 12;
  const labels: string[] = [];
  while (msg[off] !== 0) {
    const len = msg[off]!;
    labels.push(msg.subarray(off + 1, off + 1 + len).toString("ascii"));
    off += len + 1;
  }
  off += 1;
  const qtype = msg.readUInt16BE(off);
  return { id, name: labels.join("."), qtype, questionEnd: off + 4 };
}

function rr(type: number, rdata: Buffer): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(0xc00c, 0); // pointer to the question name
  b.writeUInt16BE(type, 2);
  b.writeUInt16BE(1, 4); // IN
  b.writeUInt32BE(5, 6); // TTL 5 s
  b.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([b, rdata]);
}

function txtRdata(text: string): Buffer {
  const chunks: Buffer[] = [];
  const data = Buffer.from(text, "utf8");
  for (let i = 0; i < data.length; i += 255) {
    const part = data.subarray(i, i + 255);
    chunks.push(Buffer.from([part.length]), part);
  }
  return Buffer.concat(chunks);
}

function ipv6Bytes(ip: string): Buffer {
  // Embedded dotted IPv4 tail (e.g. ::ffff:10.0.0.1) → two hex groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    ip = ip.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g || "0", 16), i * 2));
  return b;
}

// ---------------------------------------------------------------- website
export type Route = (req: IncomingMessage, res: ServerResponse) => void;

export interface FixtureSite {
  port: number;
  /** Map "host + path" → handler. Host is the Host header without port. */
  route(host: string, path: string, handler: Route | { status?: number; body: string; type?: string; headers?: Record<string, string> }): void;
  unroute(host: string, path: string): void;
  hits: Array<{ host: string; path: string }>;
  close(): Promise<void>;
}

export async function startSiteServer(port = 0, host = "127.0.0.1"): Promise<FixtureSite> {
  const routes = new Map<string, Route>();
  const hits: FixtureSite["hits"] = [];
  const server: Server = createServer((req, res) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const path = (req.url ?? "/").split("?")[0]!;
    hits.push({ host, path });
    const h = routes.get(`${host}${path}`) ?? routes.get(`*${path}`);
    if (!h) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    h(req, res);
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    route(host, path, handler) {
      routes.set(`${host.toLowerCase()}${path}`, typeof handler === "function" ? handler : (_req, res) => {
        res.writeHead(handler.status ?? 200, { "content-type": handler.type ?? "text/html; charset=utf-8", ...handler.headers });
        res.end(handler.body);
      });
    },
    unroute: (host, path) => void routes.delete(`${host.toLowerCase()}${path}`),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
export * from "./tls.js";
export * from "./fault-site.js";
