import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const app = await createApp();
await app.listen({ port: env.PORT, host: env.HOST });
console.log(`api listening on http://${env.HOST}:${env.PORT} (region ${env.REGION})`);
