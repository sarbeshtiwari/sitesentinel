import { chromium, type Browser } from "playwright-core";

/**
 * Client for the browser runner's control API (browser-control network). One session = one fresh
 * Chromium for one execution; closing the session kills it. The worker mints the capability token;
 * the runner never sees the signing secret.
 */
export class RunnerUnavailable extends Error {}
export class RunnerBusy extends Error {}

export interface BrowserSession { browser: Browser; close(): Promise<void>; sandbox: boolean }

export async function openSession(runnerUrl: string, token: string, timeoutMs: number, execution: string): Promise<BrowserSession> {
  let res: Response;
  try {
    res = await fetch(new URL("/v1/sessions", runnerUrl), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, timeoutMs, execution }), signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new RunnerUnavailable(`runner unreachable: ${(e as Error).message}`);
  }
  if (res.status === 429) throw new RunnerBusy("runner at capacity");
  if (res.status !== 201) throw new RunnerUnavailable(`runner refused (${res.status})`);
  const s = (await res.json()) as { sessionId: string; wsEndpoint: string; sandbox: boolean };
  let browser: Browser;
  try {
    browser = await chromium.connect(s.wsEndpoint, { timeout: 20_000 });
  } catch (e) {
    await fetch(new URL(`/v1/sessions/${s.sessionId}`, runnerUrl), { method: "DELETE" }).catch(() => undefined);
    throw new RunnerUnavailable(`connect failed: ${(e as Error).message.slice(0, 120)}`);
  }
  return {
    browser, sandbox: s.sandbox,
    async close() {
      await browser.close().catch(() => undefined);
      await fetch(new URL(`/v1/sessions/${s.sessionId}`, runnerUrl), { method: "DELETE", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    },
  };
}
