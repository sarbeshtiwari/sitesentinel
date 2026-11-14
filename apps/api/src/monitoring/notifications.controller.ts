import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { withMember, type Db, type Tx } from "@wim/db";
import {
  NotificationListQuery, NotificationPreferencesInput, Uuid,
  type NotificationDto, type NotificationPreferenceDto,
} from "@wim/contracts";
import { APP_DB } from "../infra/infra.module.js";
import { AuditService, orgStream } from "../audit/audit.service.js";
import { AppError, Errors } from "../common/errors.js";
import { Client, CurrentOrg, CurrentSession, parse, RequirePermission, type ClientInfo, type OrgContext, type SessionContext } from "../common/context.js";

const MANAGERS = ["OWNER", "ADMIN"];

/**
 * Phase 4F: the signed-in member's own notification centre and preferences. Every query is scoped to the
 * organisation (RLS) AND the user — another member's notifications are invisible and can't be marked read.
 * Notifications are created only by worker-notify; the customer role can set `read_at` and nothing else.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(APP_DB) private readonly db: Db, private readonly audit: AuditService) {}

  private member<T>(s: SessionContext, o: OrgContext, fn: (tx: Tx) => Promise<T>) {
    return withMember(this.db, { orgId: o.orgId, userId: s.userId }, fn);
  }

  async list(s: SessionContext, o: OrgContext, q: z.infer<typeof NotificationListQuery>): Promise<{ data: NotificationDto[]; nextCursor: string | null; unread: number }> {
    let cur: { at: Date; id: string } | null = null;
    if (q.cursor) {
      const [at, id] = Buffer.from(q.cursor, "base64url").toString("utf8").split("|");
      const d = new Date(at ?? "");
      if (Number.isNaN(d.getTime()) || !id || !/^[0-9a-f-]{36}$/.test(id)) throw new AppError(400, "VALIDATION_FAILED", "Invalid cursor");
      cur = { at: d, id };
    }
    return this.member(s, o, async (tx) => {
      const rows = await tx.notification.findMany({
        where: {
          orgId: o.orgId, userId: s.userId, ...(q.unread === "true" ? { readAt: null } : q.unread === "false" ? { readAt: { not: null } } : {}),
          ...(cur ? { OR: [{ createdAt: { lt: cur.at } }, { createdAt: cur.at, id: { lt: cur.id } }] } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const unread = await tx.notification.count({ where: { orgId: o.orgId, userId: s.userId, readAt: null } });
      const last = page[page.length - 1];
      return {
        data: page.map((r) => ({ id: r.id, type: r.type, severity: r.severity, title: r.title, body: r.body, link: relativeLink(r.link), incidentId: r.incidentId, read: r.readAt !== null, createdAt: r.createdAt.toISOString() })),
        nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url") : null,
        unread,
      };
    });
  }

  async markRead(s: SessionContext, o: OrgContext, id: string) {
    return this.member(s, o, async (tx) => {
      const n = await tx.notification.updateMany({ where: { id, orgId: o.orgId, userId: s.userId, readAt: null }, data: { readAt: new Date() } });
      if (!n.count && !(await tx.notification.count({ where: { id, orgId: o.orgId, userId: s.userId } }))) throw Errors.notFound();
      return { read: true };
    });
  }

  async markAllRead(s: SessionContext, o: OrgContext) {
    return this.member(s, o, async (tx) => {
      const n = await tx.notification.updateMany({ where: { orgId: o.orgId, userId: s.userId, readAt: null }, data: { readAt: new Date() } });
      return { marked: n.count };
    });
  }

  /** The user's preferences per channel; without a stored row, the delivery default is shown (managers: MEDIUM+). */
  async preferences(s: SessionContext, o: OrgContext): Promise<NotificationPreferenceDto[]> {
    return this.member(s, o, async (tx) => {
      const rows = await tx.notificationPreference.findMany({ where: { orgId: o.orgId, userId: s.userId, channel: { in: ["EMAIL", "IN_APP"] } } });
      const manager = MANAGERS.includes(o.roleKey);
      return (["EMAIL", "IN_APP"] as const).map((channel) => {
        const r = rows.find((x) => x.channel === channel);
        return r
          ? { channel, enabled: r.enabled, minSeverity: r.minSeverity, eventTypes: r.eventTypes as NotificationPreferenceDto["eventTypes"], websiteIds: r.websiteIds, isDefault: false }
          : { channel, enabled: manager, minSeverity: "MEDIUM", eventTypes: [], websiteIds: [], isDefault: true };
      });
    });
  }

  async savePreferences(s: SessionContext, o: OrgContext, input: z.infer<typeof NotificationPreferencesInput>, client: ClientInfo) {
    if (new Set(input.preferences.map((p) => p.channel)).size !== input.preferences.length) throw new AppError(400, "VALIDATION_FAILED", "One entry per channel");
    await this.member(s, o, async (tx) => {
      const ids = [...new Set(input.preferences.flatMap((p) => p.websiteIds))];
      if (ids.length && (await tx.website.count({ where: { id: { in: ids }, orgId: o.orgId, archivedAt: null } })) !== ids.length) {
        throw new AppError(400, "VALIDATION_FAILED", "Unknown website in the preferences", { issues: [{ path: "websiteIds", message: "Unknown website" }] });
      }
      for (const p of input.preferences) {
        const data = { enabled: p.enabled, minSeverity: p.minSeverity, eventTypes: p.eventTypes, websiteIds: p.websiteIds };
        await tx.notificationPreference.upsert({
          where: { orgId_userId_channel: { orgId: o.orgId, userId: s.userId, channel: p.channel } },
          create: { orgId: o.orgId, userId: s.userId, channel: p.channel, ...data }, update: data,
        });
      }
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "notification.preferences_updated", targetType: "user", targetId: s.userId, changes: { channels: input.preferences.map((p) => p.channel) }, client }, tx);
    });
    return this.preferences(s, o);
  }
}

/** Stored links are absolute app URLs; the API returns the path only (no host / scheme to trust). */
function relativeLink(link: string | null): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    return `${u.pathname}${u.search}`;
  } catch {
    return link.startsWith("/") && !link.startsWith("//") ? link : null;
  }
}

const id = (v: string) => parse(Uuid, v);

@Controller("api/v1/orgs/:orgId")
export class NotificationsController {
  constructor(private readonly n: NotificationsService) {}

  @Get("notifications")
  @RequirePermission("org:read")
  async list(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Query() q: unknown) {
    return this.n.list(s, o, parse(NotificationListQuery, q));
  }

  @Post("notifications/read-all")
  @RequirePermission("org:read")
  @HttpCode(200)
  async readAll(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext) {
    return { data: await this.n.markAllRead(s, o) };
  }

  @Post("notifications/:notificationId/read")
  @RequirePermission("org:read")
  @HttpCode(200)
  async read(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("notificationId") i: string) {
    return { data: await this.n.markRead(s, o, id(i)) };
  }

  @Get("notification-preferences")
  @RequirePermission("org:read")
  async prefs(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext) {
    return { data: await this.n.preferences(s, o) };
  }

  @Put("notification-preferences")
  @RequirePermission("org:read")
  async savePrefs(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.n.savePreferences(s, o, parse(NotificationPreferencesInput, body), c) };
  }
}
