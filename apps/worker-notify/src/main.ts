import { startEmailWorker } from "./index.js";

const running = startEmailWorker();
console.log("worker-notify: consuming email queue");
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    void running.stop().then(() => process.exit(0));
  });
}
