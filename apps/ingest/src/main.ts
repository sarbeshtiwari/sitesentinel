import { buildIngest } from "./index.js";

const app = await buildIngest();
const port = Number(process.env.INGEST_PORT ?? 4200);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
console.log(`ingest listening on :${port}`);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void app.close().then(() => process.exit(0)));
