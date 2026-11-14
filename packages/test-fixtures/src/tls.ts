import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Test PKI (openssl): a private CA plus leaf certificates with controlled names and
 * validity, so TLS validation, hostname mismatch, expiry and "expires in N days" are
 * tested against real handshakes. Never used outside tests.
 */
export interface TestPki {
  caPem: string;
  /** leaf for `names` valid from notBefore to notAfter; selfSigned skips the CA */
  leaf(names: string[], opts?: { notBefore?: Date; notAfter?: Date; selfSigned?: boolean }): { key: string; cert: string };
}

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";

export function createTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "wim-pki-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "3650", "-subj", "/O=WIM Test CA/CN=WIM Test Root"]);
  let n = 0;
  return {
    caPem: readFileSync(join(dir, "ca.pem"), "utf8"),
    leaf(names, opts = {}) {
      const id = `leaf${n++}`;
      const san = names.map((x) => `DNS:${x}`).join(",");
      writeFileSync(join(dir, `${id}.ext`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
      const notBefore = stamp(opts.notBefore ?? new Date(Date.now() - 86_400_000));
      const notAfter = stamp(opts.notAfter ?? new Date(Date.now() + 90 * 86_400_000));
      run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${id}.key`, "-out", `${id}.csr`, "-subj", `/O=WIM Fixture/CN=${names[0]}`]);
      // OpenSSL < 3.4 has no -not_before/-not_after: fall back to -days when no explicit window was requested.
      const explicit = Boolean(opts.notBefore || opts.notAfter);
      const sign = (signer: string[]) => {
        const base = ["x509", "-req", "-in", `${id}.csr`, ...signer, "-out", `${id}.pem`, "-extfile", `${id}.ext`];
        try {
          run([...base, "-not_before", notBefore, "-not_after", notAfter]);
        } catch (e) {
          if (!explicit) return run([...base, "-days", "90"]);
          // OpenSSL 3.0–3.3 (e.g. Ubuntu 24.04): `openssl ca` supports explicit -startdate/-enddate
          const self = signer.includes("-key");
          writeFileSync(join(dir, "ca.cnf"), `[ca]\ndefault_ca=fx\n[fx]\ndatabase=${join(dir, "index.txt")}\nnew_certs_dir=${dir}\nserial=${join(dir, "serial")}\ndefault_md=sha256\npolicy=p\nunique_subject=no\ncopy_extensions=none\n[p]\ncommonName=supplied\norganizationName=optional\n`);
          if (!existsSync(join(dir, "index.txt"))) writeFileSync(join(dir, "index.txt"), "");
          if (!existsSync(join(dir, "serial"))) writeFileSync(join(dir, "serial"), "1000\n");
          try {
            run(["ca", "-batch", "-config", "ca.cnf", "-in", `${id}.csr`, "-out", `${id}.pem`, "-extfile", `${id}.ext`, "-notext",
              "-startdate", notBefore, "-enddate", notAfter,
              ...(self ? ["-selfsign", "-keyfile", `${id}.key`] : ["-cert", "ca.pem", "-keyfile", "ca.key"])]);
          } catch {
            throw e;
          }
        }
      };
      if (opts.selfSigned) {
        sign(["-key", `${id}.key`]);
      } else {
        sign(["-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial"]);
      }
      return { key: readFileSync(join(dir, `${id}.key`), "utf8"), cert: readFileSync(join(dir, `${id}.pem`), "utf8") };
    },
  };
}

/**
 * HTTPS server choosing the certificate per SNI name at handshake time (exact match, then "*").
 * `certs` is live: entries added later are used by subsequent handshakes.
 */
export async function startTlsSite(
  certs: Map<string, { key: string; cert: string }>, handler: (req: IncomingMessage, res: ServerResponse) => void, port = 0, host = "127.0.0.1",
): Promise<{ port: number; server: Server; close(): Promise<void> }> {
  const { createSecureContext } = await import("node:tls");
  const cache = new WeakMap<object, ReturnType<typeof createSecureContext>>();
  const ctxFor = (name: string) => {
    const c = certs.get(name.toLowerCase()) ?? certs.get("*") ?? [...certs.values()][0]!;
    let ctx = cache.get(c);
    if (!ctx) { ctx = createSecureContext(c); cache.set(c, ctx); }
    return ctx;
  };
  const fallback = certs.get("*") ?? [...certs.values()][0]!;
  // Node 25.9 segfaults in closeAllConnections()/the connection checker when a client abandoned a TLS
  // handshake (e.g. a probe refusing an untrusted certificate): track raw sockets and destroy them ourselves.
  const server = createHttpsServer({ ...fallback, SNICallback: (name, cb) => cb(null, ctxFor(name)), connectionsCheckingInterval: 2_147_483_647 }, handler);
  const raw = new Set<import("node:net").Socket>();
  server.on("connection", (sock: import("node:net").Socket) => { raw.add(sock); sock.on("close", () => raw.delete(sock)); sock.on("error", () => undefined); });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((r) => server.listen(port, host, r));
  return {
    port: (server.address() as AddressInfo).port, server,
    close: () => new Promise<void>((r) => { for (const sock of raw) sock.destroy(); server.close(() => r()); }),
  };
}
