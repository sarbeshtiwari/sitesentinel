import { hostname } from "node:os";
import { Controller, Get, Inject, Res, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { createRedisHeartbeat } from "@wim/queue";
import { ENV, type Env } from "../config/env.js";
import type { FastifyReply } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "@wim/db";
import { APP_DB, REDIS } from "../infra/infra.module.js";
import { Infra } from "../common/context.js";

/** Internal-network probes (Nginx does not expose /health). */
@Controller("health")
export class HealthController implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_DB) private readonly db: Db, @Inject(REDIS) private readonly redis: Redis, @Inject(ENV) private readonly env: Env) {}

  // release readiness: the API reports liveness + readiness to the platform health evaluator (Redis key with TTL; the
  // customer database role cannot write operational tables, by design)
  private hb?: { stop(): Promise<void> };
  onModuleInit() {
    if (this.env.NODE_ENV === "test") return;
    this.hb = createRedisHeartbeat({ connection: this.redis, prefix: this.env.QUEUE_PREFIX, kind: "api", id: `${hostname()}-${process.pid}`,
      check: async () => ({ postgres: await this.db.$queryRaw`SELECT 1`.then(() => true, () => false) }) });
  }
  async onModuleDestroy() { await this.hb?.stop(); }

  @Infra()
  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Infra()
  @Get("ready")
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const checks: Record<string, "ok" | "fail"> = {};
    await Promise.all([
      this.db.$queryRaw`SELECT 1`.then(() => (checks.postgres = "ok"), () => (checks.postgres = "fail")),
      this.redis.ping().then(() => (checks.redis = "ok"), () => (checks.redis = "fail")),
    ]);
    const ok = Object.values(checks).every((v) => v === "ok");
    void reply.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "degraded", checks };
  }
}
