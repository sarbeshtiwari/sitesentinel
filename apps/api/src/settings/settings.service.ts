import { Controller, Get, Global, Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { SettingsSnapshot } from "@wim/core";
import { loadSettings, type Db } from "@wim/db";
import type { DataEnvelope, PublicConfigDto } from "@wim/contracts";
import { APP_DB, REDIS } from "../infra/infra.module.js";
import { Public } from "../common/context.js";

export const CONFIG_CHANNEL = "wim:config:changed";
const TTL_MS = 30_000;

/**
 * Reads operational settings from platform_settings (ARCHITECTURE.md §19).
 * Cached for 30 s and invalidated immediately via Redis pub/sub when an admin
 * changes a value, so changes apply without a redeploy.
 */
@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
  private cache: { value: SettingsSnapshot; expires: number } | null = null;
  private subscriber?: Redis;

  constructor(@Inject(APP_DB) private readonly db: Db, @Inject(REDIS) private readonly redis: Redis) {}

  async onModuleInit() {
    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe(CONFIG_CHANNEL);
    this.subscriber.on("message", () => this.invalidate());
  }

  async onModuleDestroy() {
    this.subscriber?.disconnect();
  }

  invalidate() {
    this.cache = null;
  }

  async get(): Promise<SettingsSnapshot> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.value;
    const value = await loadSettings(this.db);
    this.cache = { value, expires: Date.now() + TTL_MS };
    return value;
  }

  /** Called by the admin settings endpoint after a committed change. */
  async publishChange(keys: string[]) {
    this.invalidate();
    await this.redis.publish(CONFIG_CHANNEL, JSON.stringify({ keys, at: Date.now() }));
  }
}

/** Branding and public policy for the web and admin apps (GET /api/v1/public/config). */
@Controller("api/v1/public")
export class PublicConfigController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get("config")
  async config(): Promise<DataEnvelope<PublicConfigDto>> {
    const s = await this.settings.get();
    return {
      data: {
        productName: s["branding.productName"],
        logoUrl: s["branding.logoUrl"],
        faviconUrl: s["branding.faviconUrl"],
        primaryColor: s["branding.primaryColor"],
        supportEmail: s["branding.supportEmail"],
        termsUrl: s["legal.termsUrl"],
        privacyUrl: s["legal.privacyUrl"],
        termsVersion: s["legal.termsVersion"],
        registration: s["auth.registration"],
        passwordMinLength: s["auth.password.minLength"],
        maintenanceMode: s["platform.maintenanceMode"],
      },
    };
  }
}

@Global()
@Module({ providers: [SettingsService], controllers: [PublicConfigController], exports: [SettingsService] })
export class SettingsModule {}
