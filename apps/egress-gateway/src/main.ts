import { configFromEnv, Gateway } from "./index.js";

const cfg = configFromEnv();
const gw = new Gateway(cfg);
await gw.listen(Number(process.env.EGRESS_PORT ?? 8080));
console.log(`egress-gateway listening on :${process.env.EGRESS_PORT ?? 8080} (ports ${cfg.allowedPorts.join(",")}, resolvers ${cfg.resolvers.join(",")})`);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void gw.close().then(() => process.exit(0)));
