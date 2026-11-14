import { startVerifyWorker } from "./index.js";

const running = startVerifyWorker();
console.log("worker-http: consuming verify queue");
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => void running.stop().then(() => process.exit(0)));
}
