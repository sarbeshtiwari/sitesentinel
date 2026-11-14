import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { createDb, type Db } from "@wim/db";
import { EMAIL_QUEUE, type EmailJob } from "@wim/contracts";
import { ENV, loadEnv, type Env } from "../config/env.js";

export const APP_DB = Symbol("APP_DB");
export const ADMIN_DB = Symbol("ADMIN_DB");
export const REDIS = Symbol("REDIS");

/** Typed producer for transactional email jobs (consumed by apps/worker-notify). */
@Injectable()
export class EmailQueue {
  readonly queue: Queue<EmailJob>;
  constructor(@Inject(ENV) env: Env, @Inject(REDIS) redis: Redis) {
    this.queue = new Queue<EmailJob>(EMAIL_QUEUE, { connection: redis, prefix: env.QUEUE_PREFIX });
  }

  /** jobId doubles as the provider idempotency key; retries never send twice. */
  async enqueue(job: EmailJob, jobId: string): Promise<void> {
    await this.queue.add(job.kind, job, {
      // BullMQ reserves ":" in custom ids; normalise every id here rather than at each call site.
      jobId: jobId.replaceAll(":", "."),
      attempts: 6,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 24 * 3600, count: 10_000 },
      removeOnFail: { age: 14 * 24 * 3600 },
    });
  }
}

@Injectable()
class InfraShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(APP_DB) private readonly appDb: Db,
    @Inject(ADMIN_DB) private readonly adminDb: Db,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly emailQueue: EmailQueue,
  ) {}
  async onApplicationShutdown() {
    await this.emailQueue.queue.close();
    await Promise.allSettled([this.appDb.$disconnect(), this.adminDb.$disconnect()]);
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    // Customer API connects as wim_app (RLS-bound, write-only secret columns hidden).
    { provide: APP_DB, inject: [ENV], useFactory: (env: Env) => createDb({ url: env.DATABASE_URL, omitSecrets: true }) },
    // Admin API connects as wim_admin: no grants on tenant content tables (050_grants.sql).
    { provide: ADMIN_DB, inject: [ENV], useFactory: (env: Env) => createDb({ url: env.ADMIN_DATABASE_URL, max: 4, omitSecrets: true }) },
    { provide: REDIS, inject: [ENV], useFactory: (env: Env) => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false }) },
    EmailQueue,
    InfraShutdown,
  ],
  exports: [ENV, APP_DB, ADMIN_DB, REDIS, EmailQueue],
})
export class InfraModule {}
