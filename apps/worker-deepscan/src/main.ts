import { startDeepScanWorker } from "./index.js";

const running = await startDeepScanWorker();
console.log("worker-deepscan: consuming deep-scan");
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void running.stop().then(() => process.exit(0)));
