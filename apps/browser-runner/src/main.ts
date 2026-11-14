import { BrowserRunner, RunnerEnv } from "./index.js";

const env = RunnerEnv.parse(process.env);
if (env.RUNNER_TEST_TRUST_SPKI && env.NODE_ENV !== "test") throw new Error("RUNNER_TEST_TRUST_SPKI is only permitted when NODE_ENV=test");
if (env.RUNNER_SANDBOX === false) console.warn("browser-runner: Chromium sandbox DISABLED by configuration");
const runner = new BrowserRunner({
  gatewayUrl: env.RUNNER_GATEWAY_URL, advertiseHost: env.RUNNER_ADVERTISE_HOST, bindHost: env.RUNNER_BIND_HOST,
  maxSessions: env.RUNNER_MAX_SESSIONS, maxSessionMs: env.RUNNER_MAX_SESSION_MS, sandbox: env.RUNNER_SANDBOX, testTrustSpki: env.RUNNER_TEST_TRUST_SPKI,
  log: (msg, data) => console.log(JSON.stringify({ msg, ...data })),
});
const port = await runner.listen(env.RUNNER_PORT);
console.log(JSON.stringify({ msg: "browser-runner listening", port, sandbox: env.RUNNER_SANDBOX, maxSessions: env.RUNNER_MAX_SESSIONS }));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void runner.stop().then(() => process.exit(0)));
