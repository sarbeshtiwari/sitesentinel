import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type BrowserServer } from "playwright-core";
import { z } from "zod";
import { BROWSER_LAUNCH_ARGS } from "@wim/netguard";

/**
 * Browser runner (Phase 4D). Runs where Chromium runs — a container on `browser-control` +
 * `browser-egress` only: no database, no Redis, no object storage, no signing secret.
 *
 * worker-browser (the trusted control plane) asks for a session per execution and passes a
 * capability token the WORKER minted. The runner launches a fresh Chromium with:
 *  - the gateway as proxy, taken from the runner's OWN configuration (a caller can't redirect it)
 *  - no implicit loopback bypass ("<-loopback>"), so page content can't reach this control API
 *  - Chromium's sandbox ON (unless explicitly disabled for an environment that can't support it)
 *  - fixed hardened flags; downloads/service workers are disabled per context by the caller
 * and a hard kill timer, so no browser outlives its job.
 */
export interface RunnerConfig {
  gatewayUrl: string;
  /** host name/IP the worker uses to reach this runner (written into the returned WS endpoint) */
  advertiseHost: string;
  bindHost: string;
  maxSessions: number;
  maxSessionMs: number;
  sandbox: boolean;
  executablePath?: string;
  /** NODE_ENV=test only: base64 SHA-256 SPKI of the fixture test CA Chromium may trust (checked by main.ts) */
  testTrustSpki?: string;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const SessionRequest = z.object({
  token: z.string().min(20).max(4096).regex(/^[A-Za-z0-9_.-]+$/),
  timeoutMs: z.number().int().min(5000),
  execution: z.string().max(80).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
}).strict();

interface Session { id: string; server: BrowserServer; timer: NodeJS.Timeout; started: number; execution?: string }

export class BrowserRunner {
  readonly sessions = new Map<string, Session>();
  server!: Server;
  launched = 0;
  killedByTimeout = 0;

  constructor(readonly cfg: RunnerConfig) {}

  async listen(port: number): Promise<number> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(port, this.cfg.bindHost, r));
    return (this.server.address() as AddressInfo).port;
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? "/", "http://runner");
      if (req.method === "GET" && url.pathname === "/health") {
        return this.json(res, 200, { ok: true, sessions: this.sessions.size, maxSessions: this.cfg.maxSessions, sandbox: this.cfg.sandbox, launched: this.launched, killedByTimeout: this.killedByTimeout });
      }
      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        let raw = "";
        for await (const c of req) { raw += c; if (raw.length > 8192) return this.json(res, 413, { error: "too large" }); }
        const p = SessionRequest.safeParse(JSON.parse(raw || "{}"));
        if (!p.success) return this.json(res, 400, { error: "invalid request" });
        if (this.sessions.size >= this.cfg.maxSessions) return this.json(res, 429, { error: "runner at capacity" });
        const s = await this.open(p.data.token, Math.min(p.data.timeoutMs, this.cfg.maxSessionMs), p.data.execution);
        return this.json(res, 201, { sessionId: s.id, wsEndpoint: s.server.wsEndpoint().replace(/^ws:\/\/[^/]+/, `ws://${this.cfg.advertiseHost}:${new URL(s.server.wsEndpoint()).port}`), sandbox: this.cfg.sandbox, expiresInMs: Math.min(p.data.timeoutMs, this.cfg.maxSessionMs) });
      }
      const del = /^\/v1\/sessions\/([a-f0-9]{32})$/.exec(url.pathname);
      if (req.method === "DELETE" && del) {
        await this.close(del[1]!);
        return this.json(res, 200, { ok: true });
      }
      return this.json(res, 404, { error: "not found" });
    } catch (e) {
      this.cfg.log?.("runner error", { err: (e as Error).message.slice(0, 200) });
      return this.json(res, 503, { error: "browser launch failed" });
    }
  }

  async open(token: string, timeoutMs: number, execution?: string): Promise<Session> {
    const id = randomBytes(16).toString("hex");
    const server = await chromium.launchServer({
      executablePath: this.cfg.executablePath,
      headless: true,
      chromiumSandbox: this.cfg.sandbox,
      host: this.cfg.bindHost,
      port: 0,
      wsPath: `/${randomBytes(24).toString("hex")}`, // unguessable: the WS endpoint is a bearer capability
      args: [...BROWSER_LAUNCH_ARGS, "--disable-extensions", "--disable-features=Translate,MediaRouter,OptimizationHints", "--deny-permission-prompts", "--disable-dev-shm-usage",
        ...(this.cfg.testTrustSpki ? [`--ignore-certificate-errors-spki-list=${this.cfg.testTrustSpki}`] : [])],
      proxy: { server: this.cfg.gatewayUrl, username: "cap", password: token, bypass: "<-loopback>" },
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    this.launched++;
    const timer = setTimeout(() => {
      this.killedByTimeout++;
      this.cfg.log?.("session exceeded its time budget; killing browser", { execution });
      void server.kill();
    }, timeoutMs);
    const s: Session = { id, server, timer, started: Date.now(), execution };
    this.sessions.set(id, s);
    server.process().once("exit", () => { clearTimeout(timer); this.sessions.delete(id); });
    return s;
  }

  async close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    this.sessions.delete(id);
    await s.server.close().catch(() => s.server.kill());
  }

  async stop() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }
}

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
export const RunnerEnv = z.object({
  RUNNER_PORT: z.coerce.number().int().default(3000),
  RUNNER_BIND_HOST: z.string().default("0.0.0.0"),
  RUNNER_ADVERTISE_HOST: z.string().default("browser-runner"),
  RUNNER_GATEWAY_URL: z.url(),
  RUNNER_MAX_SESSIONS: z.coerce.number().int().min(1).max(32).default(2),
  RUNNER_MAX_SESSION_MS: z.coerce.number().int().min(10_000).max(900_000).default(180_000),
  /** Chromium sandbox. Requires the chromium seccomp profile (infra/security/seccomp/chromium.json). */
  RUNNER_SANDBOX: bool.default(true),
  NODE_ENV: z.string().default("production"),
  /** test-only: trust the fixture CA (base64 SPKI SHA-256); refused unless NODE_ENV=test */
  RUNNER_TEST_TRUST_SPKI: z.string().regex(/^[A-Za-z0-9+/=]{44}$/).optional(),
});
