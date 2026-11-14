import { randomToken, sha256Hex } from "@wim/crypto";
import { loadSettings, withSystem, type Db } from "@wim/db";
import { EmailJob, type SecurityNotice } from "@wim/contracts";
import { EmailSendError, templates, type Branding, type EmailProvider, type Rendered } from "@wim/email";
import type { Logger } from "@wim/logger";

export interface ProcessorDeps {
  /** Phase 4H: Super Admin console URL (links in platform alerts) and fallback recipients when PostgreSQL is down */
  adminUrl?: string;
  fallbackAlertEmails?: string[];
  db: Db;
  provider: EmailProvider;
  log: Logger;
  appUrl: string;
  fromLocalPart: string;
  fromDomain: string;
}

export interface ProcessResult { status: "SENT" | "SKIPPED"; reason?: string }

/** A failure that must not be retried (e.g. invalid recipient). BullMQ's UnrecoverableError equivalent. */
export class PermanentJobError extends Error {}

/**
 * Turns an email job (ids only) into a sent message. Tokens are generated here,
 * at send time: the raw token exists only in this process's memory and in the
 * email itself; the database stores its SHA-256.
 */
const SEV = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16);
const human = (sec: number) => (sec < 120 ? `${sec} seconds` : sec < 7200 ? `${Math.round(sec / 60)} minutes` : `${Math.round(sec / 360) / 10} hours`);

export function createEmailProcessor(deps: ProcessorDeps) {
  const link = (path: string, token?: string) => {
    const u = new URL(path, deps.appUrl);
    if (token) u.searchParams.set("token", token);
    return u.toString();
  };

  return async function process(raw: unknown, jobId: string): Promise<ProcessResult> {
    const job = EmailJob.parse(raw);
    // PostgreSQL is unavailable for this one: no settings, no logs — straight to the provider, idempotent by job id
    if (job.kind === "PLATFORM_ALERT_DIRECT") return directAlert(job, jobId);
    const settings = await loadSettings(deps.db);
    const branding: Branding = {
      productName: settings["branding.productName"],
      primaryColor: settings["branding.primaryColor"],
      supportEmail: settings["branding.supportEmail"],
      logoUrl: settings["branding.logoUrl"],
    };

    if (job.kind === "PLATFORM_ALERT") return platformAlert(job, jobId, branding, settings);
    const built = await build(job, branding, settings, jobId);
    if ("skip" in built) return { status: "SKIPPED", reason: built.skip };
    if ("many" in built) {
      for (const one of built.many) await sendOne(job, jobId, branding, one);
      return { status: built.many.length ? "SENT" : "SKIPPED" };
    }
    return sendOne(job, jobId, branding, built);
  };

  async function sendOne(job: EmailJob, jobId: string, branding: Branding, built: Single): Promise<ProcessResult> {

    // Display name cannot contain characters that would break the From header.
    const displayName = branding.productName.replace(/["\r\n<>]/g, "").trim() || "Notifications";
    try {
      const out = await deps.provider.send({
        from: `"${displayName}" <${deps.fromLocalPart}@${deps.fromDomain}>`,
        replyTo: branding.supportEmail ?? undefined,
        to: built.to,
        ...built.message,
        idempotencyKey: `${jobId}.${built.recipientRef}`,
        tags: { kind: job.kind },
      });
      await logDelivery(built.orgId, built.recipientRef, job.kind, jobId, "SENT", out.providerMessageId, null);
      return { status: "SENT" };
    } catch (e) {
      await logDelivery(built.orgId, built.recipientRef, job.kind, jobId, "FAILED", null, (e as Error).message.slice(0, 300));
      if (e instanceof EmailSendError && !e.retryable) throw new PermanentJobError(e.message);
      throw e;
    }
  }

  // ---------------------------------------------------------------------------- Phase 4H: platform alerts
  async function platformAlert(job: Extract<EmailJob, { kind: "PLATFORM_ALERT" }>, jobId: string, b: Branding, settings: Awaited<ReturnType<typeof loadSettings>>): Promise<ProcessResult> {
    const ev = await withSystem(deps.db, (tx) => tx.outboxEvent.findUnique({ where: { id: BigInt(job.outboxId) } }));
    if (!ev || ev.topic !== "platform.alert" || ev.orgId) return { status: "SKIPPED", reason: "unknown platform alert event" };
    const { alertId, event } = ev.payload as { alertId: string; event: string };
    const alert = await withSystem(deps.db, (tx) => tx.platformAlert.findUnique({ where: { id: alertId } }));
    if (!alert) return { status: "SKIPPED", reason: "alert not found" };
    // acknowledged meanwhile → no repeat notification (recoveries are still sent)
    if (event === "RENOTIFY" && alert.state !== "OPEN") return { status: "SKIPPED", reason: "acknowledged" };
    const configured = settings["ops.alerts.recipients"];
    const to = configured.length ? configured : (await withSystem(deps.db, (tx) => tx.$queryRaw<Array<{ email: string }>>`SELECT email FROM ops.alert_recipients()`)).map((r) => r.email);
    if (!to.length) {
      await alertEvent(alertId, "NOTIFY_FAILED", { reason: "no recipients configured or active operators" });
      await withSystem(deps.db, (tx) => tx.platformAlert.update({ where: { id: alertId }, data: { notifyState: "FAILED" } }));
      return { status: "SKIPPED", reason: "no recipients" };
    }
    const message = templates.platformAlert(b, { event, severity: alert.severity, rule: alert.rule, component: alert.component, reason: alert.reason, since: fmt(alert.openedAt), occurrences: alert.occurrences, url: new URL("/alerts", deps.adminUrl ?? deps.appUrl).toString() });
    const sent = await alreadySent(jobId);
    try {
      for (const email of to) {
        const ref = sha256Hex(email.toLowerCase()).slice(0, 32); // operators are not customer users: hashed reference, no org
        if (sent.has(ref)) continue;
        await sendOne(job, jobId, b, { to: email, orgId: null, recipientRef: ref, message });
      }
    } catch (e) {
      await alertEvent(alertId, "NOTIFY_FAILED", { event, error: (e as Error).message.slice(0, 200) });
      await withSystem(deps.db, (tx) => tx.platformAlert.update({ where: { id: alertId }, data: { notifyState: "FAILED" } })).catch(() => undefined);
      throw e;
    }
    await alertEvent(alertId, "NOTIFY_SENT", { event, recipients: to.length });
    if (event !== "RECOVERED") await withSystem(deps.db, (tx) => tx.platformAlert.update({ where: { id: alertId }, data: { notifyState: "SENT" } }));
    return { status: "SENT" };
  }
  async function alertEvent(alertId: string, type: string, details: Record<string, unknown>) {
    await withSystem(deps.db, (tx) => tx.platformAlertEvent.create({ data: { alertId, type, details: details as object } })).catch(() => undefined);
  }
  async function directAlert(job: Extract<EmailJob, { kind: "PLATFORM_ALERT_DIRECT" }>, jobId: string): Promise<ProcessResult> {
    const to = deps.fallbackAlertEmails ?? [];
    if (!to.length) return { status: "SKIPPED", reason: "OPS_FALLBACK_ALERT_EMAILS not configured" };
    for (const email of to) {
      await deps.provider.send({
        from: `"Platform alerts" <${deps.fromLocalPart}@${deps.fromDomain}>`, to: email,
        subject: `[CRITICAL] platform: PostgreSQL unavailable since ${fmt(new Date(job.since))} UTC`,
        text: `PostgreSQL is unavailable (detected by ${job.evaluator}): ${job.reason}\n\nThe alert will be recorded in the Super Admin console once the database is reachable again.`,
        html: `<p>PostgreSQL is unavailable (detected by ${job.evaluator.replace(/[<>&"]/g, "")}): ${job.reason.replace(/[<>&"]/g, "")}</p><p>The alert will be recorded in the Super Admin console once the database is reachable again.</p>`,
        idempotencyKey: `${jobId}.${sha256Hex(email.toLowerCase()).slice(0, 16)}`, tags: { kind: job.kind },
      });
    }
    return { status: "SENT" };
  }

  async function logDelivery(orgId: string | null, recipientRef: string, eventType: string, key: string, status: "SENT" | "FAILED", providerMessageId: string | null, lastError: string | null) {
    await withSystem(deps.db, (tx) =>
      tx.notificationDeliveryLog.createMany({
        data: { orgId, channel: "EMAIL", recipientRef, eventType, idempotencyKey: key, status, attempts: 1, providerMessageId, lastError, sentAt: status === "SENT" ? new Date() : null },
      }),
    );
  }

  type Single = { to: string; message: Rendered; orgId: string | null; recipientRef: string };
  type Built = { skip: string } | Single | { many: Single[] };

  /** Owners and admins of an org (for domain notices). */
  async function orgManagers(orgId: string) {
    return withSystem(deps.db, (tx) => tx.organizationMember.findMany({
      where: { orgId, role: { key: { in: ["OWNER", "ADMIN"] }, orgId: null } },
      select: { userId: true, user: { select: { email: true, status: true } } },
    }));
  }

  async function build(job: EmailJob, b: Branding, s: Awaited<ReturnType<typeof loadSettings>>, jobId = ""): Promise<Built> {
    const db = deps.db;
    switch (job.kind) {
      case "VERIFY_EMAIL": {
        const user = await db.user.findUnique({ where: { id: job.userId }, select: { email: true, name: true, emailVerifiedAt: true, status: true } });
        if (!user || user.status !== "ACTIVE") return { skip: "user not active" };
        if (user.emailVerifiedAt) return { skip: "already verified" };
        const token = randomToken(32);
        const ttlHours = s["auth.emailVerification.ttlHours"];
        await db.emailVerificationToken.create({
          data: { userId: job.userId, email: user.email, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + ttlHours * 3_600_000) },
        });
        return { to: user.email, orgId: null, recipientRef: job.userId, message: templates.verifyEmail(b, { name: user.name, url: link("/verify-email", token), ttlHours }) };
      }
      case "ACCOUNT_EXISTS": {
        const user = await db.user.findUnique({ where: { id: job.userId }, select: { email: true } });
        if (!user) return { skip: "user missing" };
        return { to: user.email, orgId: null, recipientRef: job.userId, message: templates.accountExists(b, { loginUrl: link("/login"), resetUrl: link("/forgot-password") }) };
      }
      case "PASSWORD_RESET": {
        const user = await db.user.findUnique({ where: { id: job.userId }, select: { email: true, status: true } });
        if (!user || user.status !== "ACTIVE") return { skip: "user not active" };
        const token = randomToken(32);
        const ttlMinutes = s["auth.passwordReset.ttlMinutes"];
        await db.passwordResetToken.create({ data: { userId: job.userId, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + ttlMinutes * 60_000) } });
        return { to: user.email, orgId: null, recipientRef: job.userId, message: templates.passwordReset(b, { url: link("/reset-password", token), ttlMinutes }) };
      }
      case "SECURITY_NOTICE": {
        const user = await db.user.findUnique({ where: { id: job.userId }, select: { email: true } });
        if (!user) return { skip: "user missing" };
        return { to: user.email, orgId: null, recipientRef: job.userId, message: notice(b, job.notice, job.data ?? {}) };
      }
      case "MFA_RESET_CONFIRM":
      case "MFA_RESET_SCHEDULED": {
        const token = randomToken(32);
        const confirm = job.kind === "MFA_RESET_CONFIRM";
        const req = await withSystem(db, async (tx) => {
          const r = await tx.accountRecoveryRequest.findUnique({ where: { id: job.requestId }, select: { userId: true, status: true, eligibleAt: true } });
          if (!r || r.status !== (confirm ? "PENDING_EMAIL" : "WAITING")) return null;
          await tx.accountRecoveryRequest.update({
            where: { id: job.requestId },
            data: confirm
              ? { confirmTokenHash: sha256Hex(token), confirmExpiresAt: new Date(Date.now() + 3_600_000) }
              : { cancelTokenHash: sha256Hex(token) },
            select: { id: true },
          });
          return r;
        });
        if (!req) return { skip: "request no longer pending" };
        const user = await db.user.findUniqueOrThrow({ where: { id: req.userId }, select: { email: true } });
        const message = confirm
          ? templates.mfaResetConfirm(b, { url: link("/2fa-reset/confirm", token), delayHours: s["auth.mfaReset.delayHours"] })
          : templates.mfaResetScheduled(b, { eligibleAt: req.eligibleAt!.toISOString().replace("T", " ").slice(0, 16), cancelUrl: link("/2fa-reset/cancel", token) });
        return { to: user.email, orgId: null, recipientRef: req.userId, message };
      }
      case "TRANSFER_REQUESTED":
      case "TRANSFER_DECIDED":
        return buildTransfer(job, b);
      case "MONITORING_NOTICE":
        return buildMonitoring(job, b, jobId);
      case "PLATFORM_ALERT":
      case "PLATFORM_ALERT_DIRECT":
        return { skip: "handled before build" };
      case "OWNERSHIP_NOTICE":
        return buildOwnership(job, b, s);
      case "INVITATION": {
        const token = randomToken(32);
        const inv = await withSystem(db, async (tx) => {
          const i = await tx.invitation.findFirst({
            where: { id: job.invitationId, orgId: job.orgId, status: "PENDING", expiresAt: { gt: new Date() } },
            select: { email: true, expiresAt: true, roleId: true, invitedById: true, organization: { select: { name: true } } },
          });
          if (!i) return null;
          // Rotating the token on every send invalidates links from earlier emails.
          await tx.invitation.update({ where: { id: job.invitationId }, data: { tokenHash: sha256Hex(token), lastSentAt: new Date() }, select: { id: true } });
          const role = await tx.role.findUniqueOrThrow({ where: { id: i.roleId }, select: { name: true } });
          return { ...i, roleName: role.name };
        });
        if (!inv) return { skip: "invitation no longer pending" };
        const inviter = await db.user.findUnique({ where: { id: inv.invitedById }, select: { name: true, email: true } });
        return {
          to: inv.email, orgId: job.orgId, recipientRef: `invitation:${job.invitationId}`,
          message: templates.invitation(b, {
            orgName: inv.organization.name, inviterName: inviter?.name ?? inviter?.email ?? "A teammate", roleName: inv.roleName,
            url: link("/invitations/accept", token), expiresAt: inv.expiresAt.toISOString().slice(0, 10),
          }),
        };
      }
    }
  }

  async function buildTransfer(job: Extract<EmailJob, { kind: "TRANSFER_REQUESTED" | "TRANSFER_DECIDED" }>, b: Branding): Promise<Built> {
    const t = await withSystem(deps.db, (tx) => tx.domainTransfer.findUnique({ where: { id: job.transferId }, include: { domainRegistry: true } }));
    if (!t) return { skip: "transfer missing" };
    const host = t.domainRegistry.displayHost;
    const many: Single[] = [];
    const add = async (orgId: string | null, f: (orgId: string) => Rendered) => {
      if (!orgId) return;
      for (const m of await orgManagers(orgId)) {
        if (m.user.status === "ACTIVE") many.push({ to: m.user.email, orgId, recipientRef: m.userId, message: f(orgId) });
      }
    };
    if (job.kind === "TRANSFER_REQUESTED") {
      await add(t.fromOrgId, () => templates.transferRequested(b, { host, respondBy: (t.ownerRespondBy ?? new Date()).toISOString().replace("T", " ").slice(0, 16), url: link("/websites") }));
    } else {
      const approved = t.status === "APPROVED";
      await add(t.toOrgId, () => templates.transferDecided(b, { host, approved, forRequester: true, url: link("/websites") }));
      await add(t.fromOrgId, () => templates.transferDecided(b, { host, approved, forRequester: false, url: link("/websites") }));
    }
    return { many };
  }

  async function buildOwnership(job: Extract<EmailJob, { kind: "OWNERSHIP_NOTICE" }>, b: Branding, s: Awaited<ReturnType<typeof loadSettings>>): Promise<Built> {
    const c = await withSystem(deps.db, (tx) => tx.domainClaim.findUnique({
      where: { id: job.claimId },
      select: { orgId: true, verifiedMethod: true, failingSince: true, lapsedAt: true, domainRegistry: { select: { displayHost: true } }, website: { select: { id: true } } },
    }));
    if (!c?.orgId) return { skip: "claim has no organization" };
    const host = c.domainRegistry.displayHost;
    const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16);
    const url = c.website ? link(`/o/${c.orgId}/websites/${c.website.id}?tab=verification`) : link("/");
    const method = c.verifiedMethod === "DNS_TXT" ? "DNS TXT record" : c.verifiedMethod === "WELL_KNOWN_FILE" ? "verification file" : "verification meta tag";
    const message =
      job.notice === "FAILING" ? templates.ownershipFailing(b, { host, method, lapsesAt: fmt(new Date((c.failingSince ?? new Date()).getTime() + s["revalidation.graceHours"] * 3_600_000)), url })
      : job.notice === "LAPSED" ? templates.ownershipLapsed(b, { host, releaseAt: fmt(new Date((c.lapsedAt ?? new Date()).getTime() + s["revalidation.lapseReleaseDays"] * 86_400_000)), url })
      : job.notice === "RESTORED" ? templates.ownershipRestored(b, { host, url })
      : templates.ownershipLost(b, { host, url: link("/") });
    const many: Single[] = [];
    for (const m of await orgManagers(c.orgId)) if (m.user.status === "ACTIVE") many.push({ to: m.user.email, orgId: c.orgId, recipientRef: m.userId, message });
    return { many };
  }

  // ---------------------------------------------------------------- Phase 4C monitoring notices

  /**
   * Recipients for a channel: members whose preference for that channel is enabled and matches severity / event type
   * / website; members without a preference row default to owners and admins for MEDIUM and above (both channels).
   */
  async function monitoringRecipients(orgId: string, websiteId: string, severity: string, eventType: string, channel: "EMAIL" | "IN_APP" = "EMAIL") {
    return withSystem(deps.db, async (tx) => {
      const members = await tx.organizationMember.findMany({ where: { orgId }, select: { userId: true, role: { select: { key: true } }, user: { select: { email: true, status: true } } } });
      const prefs = await tx.notificationPreference.findMany({ where: { orgId, channel } });
      return members.filter((m) => {
        if (m.user.status !== "ACTIVE") return false;
        const p = prefs.find((x) => x.userId === m.userId);
        if (!p) return ["OWNER", "ADMIN"].includes(m.role.key) && SEV.indexOf(severity) >= SEV.indexOf("MEDIUM");
        return p.enabled && SEV.indexOf(severity) >= SEV.indexOf(p.minSeverity) && (!p.eventTypes.length || p.eventTypes.includes(eventType)) && (!p.websiteIds.length || p.websiteIds.includes(websiteId));
      });
    });
  }

  /** Of these users, who still wants recovery notices on a channel (a stored preference can opt out). */
  async function wantsRecovery(orgId: string, userIds: string[], channel: "EMAIL" | "IN_APP", websiteId: string) {
    if (!userIds.length) return new Set<string>();
    const prefs = await withSystem(deps.db, (tx) => tx.notificationPreference.findMany({ where: { orgId, channel, userId: { in: userIds } } }));
    return new Set(userIds.filter((u) => {
      const p = prefs.find((x) => x.userId === u);
      return !p || (p.enabled && (!p.eventTypes.length || p.eventTypes.includes("INCIDENT_RESOLVED")) && (!p.websiteIds.length || p.websiteIds.includes(websiteId)));
    }));
  }

  /** Users already emailed for this job (retries never send twice). */
  async function alreadySent(jobId: string) {
    const rows = await withSystem(deps.db, (tx) => tx.notificationDeliveryLog.findMany({ where: { idempotencyKey: jobId, status: "SENT" }, select: { recipientRef: true } }));
    return new Set(rows.map((r) => r.recipientRef));
  }

  async function buildMonitoring(job: Extract<EmailJob, { kind: "MONITORING_NOTICE" }>, b: Branding, jobId: string): Promise<Built> {
    const ev = await withSystem(deps.db, (tx) => tx.outboxEvent.findUnique({ where: { id: BigInt(job.outboxId) } }));
    if (!ev?.orgId) return { skip: "unknown outbox event" };
    const payload = ev.payload as Record<string, unknown>;
    const orgId = ev.orgId;
    const sent = await alreadySent(jobId);
    const out: Single[] = [];
    const site = async (websiteId: string) => withSystem(deps.db, (tx) => tx.website.findFirst({ where: { id: websiteId, orgId }, select: { id: true, name: true, canonicalOrigin: true } }));
    const hostOf = (o: string) => { try { return new URL(o).host; } catch { return o; } };

    if (ev.topic === "incident.opened" || ev.topic === "incident.resolved") {
      const inc = await withSystem(deps.db, (tx) => tx.incident.findFirst({ where: { id: String(payload.incidentId), orgId } }));
      if (!inc) return { skip: "incident not found" };
      const w = await site(inc.websiteId);
      if (!w) return { skip: "website not found" };
      const url = link(`/o/${orgId}/incidents?incident=${inc.id}`);
      let users: Array<{ userId: string; user: { email: string } }>;
      let message: Rendered;
      if (ev.topic === "incident.opened") {
        // Event type by detection source, so customers can choose e.g. outages but not deep-scan findings.
        const eventType = inc.source === "BROWSER" ? "BROWSER_FAILURE" : inc.source === "DEEP_SCAN" ? "DEEP_SCAN_FINDINGS" : "INCIDENT_OPENED";
        users = await monitoringRecipients(orgId, inc.websiteId, inc.severity, eventType, "EMAIL");
        message = templates.incidentOpened(b, { site: w.name, host: hostOf(w.canonicalOrigin), number: inc.number, title: inc.title, description: inc.description, severity: inc.severity, since: fmt(inc.firstDetectedAt), url });
        const inAppUsers = await monitoringRecipients(orgId, inc.websiteId, inc.severity, eventType, "IN_APP");
        await inApp(orgId, inAppUsers.map((u) => u.userId), "INCIDENT_CREATED", inc.severity, `${inc.title}: ${w.name}`, inc.description, url, inc.id);
      } else {
        // Recovery goes only to people who were told about the outage.
        const opened = await withSystem(deps.db, (tx) => tx.outboxEvent.findUnique({ where: { dedupeKey: `incident:${inc.id}:opened:${inc.reopenCount}` }, select: { id: true } }));
        if (!opened) return { skip: "no outage notification was issued" };
        const notified = await withSystem(deps.db, (tx) => tx.notificationDeliveryLog.findMany({ where: { idempotencyKey: `outbox.${opened.id}`, status: "SENT" }, select: { recipientRef: true } }));
        const toldInApp = await withSystem(deps.db, (tx) => tx.notification.findMany({ where: { orgId, incidentId: inc.id, type: "INCIDENT_CREATED" }, select: { userId: true } }));
        const emailIds = await wantsRecovery(orgId, [...new Set(notified.map((n) => n.recipientRef))], "EMAIL", inc.websiteId);
        const inAppIds = await wantsRecovery(orgId, [...new Set(toldInApp.map((n) => n.userId))], "IN_APP", inc.websiteId);
        if (!emailIds.size && !inAppIds.size) return { skip: "no outage notification was delivered" };
        users = await withSystem(deps.db, (tx) => tx.organizationMember.findMany({ where: { orgId, userId: { in: [...emailIds] }, user: { status: "ACTIVE" } }, select: { userId: true, user: { select: { email: true } } } }));
        message = templates.incidentResolved(b, { site: w.name, host: hostOf(w.canonicalOrigin), number: inc.number, title: inc.title, duration: human(Number(payload.durationSec ?? 0)), at: fmt(inc.resolvedAt ?? new Date()), url });
        await inApp(orgId, [...inAppIds], "INCIDENT_RESOLVED", inc.severity, `Recovered: ${inc.title}: ${w.name}`, `Lasted about ${human(Number(payload.durationSec ?? 0))}`, url, inc.id);
      }
      for (const u of users) if (!sent.has(u.userId)) out.push({ to: u.user.email, orgId, recipientRef: u.userId, message });
      return { many: out };
    }
    const w = await site(String(payload.websiteId));
    if (!w) return { skip: "website not found" };
    const url = link(`/o/${orgId}/websites/${w.id}?tab=monitoring`);
    if (ev.topic === "ssl.expiring") {
      const days = Number(payload.daysRemaining ?? 0);
      const sev = days <= 3 ? "HIGH" : days <= 7 ? "MEDIUM" : "LOW";
      const users = await monitoringRecipients(orgId, w.id, sev === "LOW" ? "MEDIUM" : sev, "SSL_EXPIRING"); // expiry warnings always reach managers
      const message = templates.sslExpiring(b, { site: w.name, host: hostOf(w.canonicalOrigin), days, validTo: fmt(new Date(String(payload.validTo))), url });
      const inAppUsers = await monitoringRecipients(orgId, w.id, sev === "LOW" ? "MEDIUM" : sev, "SSL_EXPIRING", "IN_APP");
      await noticeInApp(orgId, inAppUsers.map((u) => u.userId), "SSL_EXPIRING", sev, `Certificate expires in ${days} day${days === 1 ? "" : "s"}: ${w.name}`, `The TLS certificate of ${hostOf(w.canonicalOrigin)} expires on ${fmt(new Date(String(payload.validTo)))}.`, url, `outbox:${ev.id}`);
      for (const u of users) if (!sent.has(u.userId)) out.push({ to: u.user.email, orgId, recipientRef: u.userId, message });
      return { many: out };
    }
    if (ev.topic === "monitoring.interrupted") {
      const users = await monitoringRecipients(orgId, w.id, "HIGH", "MONITORING_INTERRUPTED");
      const message = templates.monitoringInterrupted(b, { site: w.name, host: hostOf(w.canonicalOrigin), checks: Number(payload.streak ?? 0), url });
      const inAppUsers = await monitoringRecipients(orgId, w.id, "HIGH", "MONITORING_INTERRUPTED", "IN_APP");
      await noticeInApp(orgId, inAppUsers.map((u) => u.userId), "MONITORING_INTERRUPTED", "HIGH", `Monitoring interrupted: ${w.name}`, "Our monitoring infrastructure could not complete checks. This is not an outage of your website.", url, `outbox:${ev.id}`);
      for (const u of users) if (!sent.has(u.userId)) out.push({ to: u.user.email, orgId, recipientRef: u.userId, message });
      return { many: out };
    }
    return { skip: `unhandled topic ${ev.topic}` };
  }

  async function inApp(orgId: string, userIds: string[], type: string, severity: string, title: string, body: string, url: string, incidentId: string) {
    if (!userIds.length) return;
    await withSystem(deps.db, async (tx) => {
      const existing = await tx.notification.findMany({ where: { orgId, incidentId, type, userId: { in: userIds } }, select: { userId: true } });
      const have = new Set(existing.map((e) => e.userId));
      const data = userIds.filter((u) => !have.has(u)).map((userId) => ({ orgId, userId, type, severity: severity as never, title: title.slice(0, 200), body: body.slice(0, 500), link: url, incidentId }));
      if (data.length) await tx.notification.createMany({ data });
    });
  }

  /** In-app notice not tied to an incident. Idempotent per outbox event: the event id is kept in the link fragment. */
  async function noticeInApp(orgId: string, userIds: string[], type: string, severity: string, title: string, body: string, url: string, key: string) {
    if (!userIds.length) return;
    const link = `${url}#${key}`;
    await withSystem(deps.db, async (tx) => {
      const existing = await tx.notification.findMany({ where: { orgId, type, link, userId: { in: userIds } }, select: { userId: true } });
      const have = new Set(existing.map((e) => e.userId));
      const data = userIds.filter((u) => !have.has(u)).map((userId) => ({ orgId, userId, type, severity: severity as never, title: title.slice(0, 200), body: body.slice(0, 500), link }));
      if (data.length) await tx.notification.createMany({ data });
    });
  }

  function notice(b: Branding, n: SecurityNotice, data: Record<string, string | number>): Rendered {
    const resetUrl = link("/forgot-password");
    switch (n) {
      case "PASSWORD_CHANGED": return templates.passwordChanged(b, { resetUrl });
      case "TWO_FACTOR_ENABLED": return templates.twoFactorEnabled(b);
      case "TWO_FACTOR_DISABLED": return templates.twoFactorDisabled(b, { resetUrl });
      case "RECOVERY_CODE_USED": return templates.recoveryCodeUsed(b, { remaining: Number(data.remaining ?? 0) });
      case "RECOVERY_CODES_REGENERATED": return templates.recoveryCodesRegenerated(b);
      case "MFA_RESET_COMPLETED": return templates.mfaResetCompleted(b, { resetUrl });
      case "ACCOUNT_LOCKED": return templates.accountLocked(b, { minutes: Number(data.minutes ?? 60), resetUrl });
    }
  }
}
