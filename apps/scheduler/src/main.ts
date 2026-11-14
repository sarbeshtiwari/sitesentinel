import { startScheduler } from "./index.js";

const running = startScheduler();
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => void running.stop().then(() => process.exit(0)));
}
