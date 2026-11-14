import { Global, Inject, Injectable, Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../infra/infra.module.js";
import { Errors } from "./errors.js";

/** Fixed-window counters in Redis (shared by every API replica). */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Count a hit; throws RATE_LIMITED when `limit` is exceeded within `windowSec`. */
  async hit(group: string, key: string, limit: number, windowSec: number): Promise<void> {
    const count = await this.increment(group, key, windowSec);
    if (count > limit) {
      const ttl = await this.redis.ttl(this.key(group, key));
      throw Errors.rateLimited(ttl > 0 ? ttl : windowSec);
    }
  }

  /** Increment and return the current count without throwing. */
  async increment(group: string, key: string, windowSec: number): Promise<number> {
    const k = this.key(group, key);
    const [[, count]] = (await this.redis.multi().incr(k).expire(k, windowSec, "NX").exec()) as [[null, number]];
    return count;
  }

  async count(group: string, key: string): Promise<number> {
    return Number((await this.redis.get(this.key(group, key))) ?? 0);
  }

  /** Remember "now" (epoch seconds) under a key for `ttlSec`. */
  async mark(group: string, key: string, ttlSec: number): Promise<void> {
    await this.redis.set(this.key(group, key), String(Math.floor(Date.now() / 1000)), "EX", ttlSec);
  }

  /** Epoch seconds stored by mark(), or null. */
  async markedAt(group: string, key: string): Promise<number | null> {
    const v = await this.redis.get(this.key(group, key));
    return v ? Number(v) : null;
  }

  async reset(group: string, key: string): Promise<void> {
    await this.redis.del(this.key(group, key));
  }

  private key(group: string, key: string) {
    return `rl:${group}:${key}`;
  }
}

@Global()
@Module({ providers: [RateLimitService], exports: [RateLimitService] })
export class RateLimitModule {}
