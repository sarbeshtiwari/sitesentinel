import { startBrowserWorker } from "./index.js";

const running = await startBrowserWorker();
console.log("worker-browser: consuming browser-monitoring");
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void running.stop().then(() => process.exit(0)));
