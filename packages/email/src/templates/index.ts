/**
 * Transactional email templates. Every interpolated value goes through `esc()`;
 * branding comes from platform settings so rebranding needs no code change.
 */
export interface Branding {
  productName: string;
  primaryColor: string;
  supportEmail: string | null;
  logoUrl: string | null;
}

export interface Rendered { subject: string; html: string; text: string }

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(b: Branding, title: string, paragraphs: string[], cta?: { label: string; url: string }): string {
  const color = /^#[0-9a-fA-F]{6}$/.test(b.primaryColor) ? b.primaryColor : "#2563eb";
  const logo = b.logoUrl && /^https:\/\//.test(b.logoUrl)
    ? `<img src="${esc(b.logoUrl)}" alt="${esc(b.productName)}" height="28" style="height:28px">`
    : `<strong style="font-size:16px">${esc(b.productName)}</strong>`;
  const button = cta
    ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="background:${color};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600">${esc(cta.label)}</a></p>
       <p style="font-size:12px;color:#64748b;word-break:break-all">Or paste this link into your browser: ${esc(cta.url)}</p>`
    : "";
  const support = b.supportEmail ? `Questions? Contact ${esc(b.supportEmail)}.` : "";
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e2e8f0;border-radius:8px">
<tr><td style="padding:24px 28px;border-bottom:1px solid #e2e8f0">${logo}</td></tr>
<tr><td style="padding:24px 28px;font-size:14px;line-height:1.6">
<h1 style="font-size:18px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join("\n")}
${button}
</td></tr>
<tr><td style="padding:16px 28px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0">${support} This is an automated security message from ${esc(b.productName)}.</td></tr>
</table></td></tr></table></body></html>`;
}

function text(title: string, lines: string[], cta?: { label: string; url: string }): string {
  return [title, "", ...lines, ...(cta ? ["", `${cta.label}: ${cta.url}`] : [])].join("\n");
}

function render(b: Branding, subject: string, title: string, lines: string[], cta?: { label: string; url: string }): Rendered {
  return { subject: `${subject} – ${b.productName}`, html: layout(b, title, lines.map(esc), cta), text: text(title, lines, cta) };
}

export const templates = {
  verifyEmail: (b: Branding, d: { name: string | null; url: string; ttlHours: number }) =>
    render(b, "Verify your email address", `Welcome${d.name ? `, ${d.name}` : ""}`,
      [`Confirm your email address to finish setting up your ${b.productName} account.`, `This link expires in ${d.ttlHours} hours.`],
      { label: "Verify email", url: d.url }),

  accountExists: (b: Branding, d: { loginUrl: string; resetUrl: string }) =>
    render(b, "Sign-up attempt for your account", "You already have an account",
      ["Someone tried to create an account with this email address. If that was you, sign in instead or reset your password.", "If it wasn't you, you can ignore this email; your account is unchanged.", `Reset password: ${d.resetUrl}`],
      { label: "Sign in", url: d.loginUrl }),

  passwordReset: (b: Branding, d: { url: string; ttlMinutes: number }) =>
    render(b, "Reset your password", "Password reset requested",
      [`Use the link below to choose a new password. It expires in ${d.ttlMinutes} minutes and can be used once.`, "Resetting your password signs you out everywhere. Two-factor authentication stays enabled.", "If you did not request this, ignore this email."],
      { label: "Reset password", url: d.url }),

  passwordChanged: (b: Branding, d: { resetUrl: string }) =>
    render(b, "Your password was changed", "Password changed",
      ["The password for your account was just changed and other sessions were signed out.", `If this wasn't you, reset your password immediately: ${d.resetUrl}`]),

  twoFactorEnabled: (b: Branding) =>
    render(b, "Two-factor authentication enabled", "Two-factor authentication is on",
      ["Signing in now requires a code from your authenticator app.", "Keep your recovery codes somewhere safe; each can be used once if you lose your device."]),

  twoFactorDisabled: (b: Branding, d: { resetUrl: string }) =>
    render(b, "Two-factor authentication disabled", "Two-factor authentication is off",
      ["Two-factor authentication was turned off for your account.", `If this wasn't you, reset your password immediately: ${d.resetUrl}`]),

  recoveryCodeUsed: (b: Branding, d: { remaining: number }) =>
    render(b, "A recovery code was used", "Recovery code used to sign in",
      [`A recovery code was just used to sign in to your account. You have ${d.remaining} unused code${d.remaining === 1 ? "" : "s"} left.`, "If this wasn't you, change your password and regenerate your recovery codes now."]),

  recoveryCodesRegenerated: (b: Branding) =>
    render(b, "New recovery codes generated", "Recovery codes regenerated",
      ["New two-factor recovery codes were generated. Your previous codes no longer work."]),

  mfaResetConfirm: (b: Branding, d: { url: string; delayHours: number }) =>
    render(b, "Confirm two-factor reset", "Lost access to your authenticator?",
      [`A request was made to remove two-factor authentication from your account. If you confirm, it is removed after a ${d.delayHours}-hour security waiting period, during which you will be notified and can cancel.`, "If you did not make this request, ignore this email and consider changing your password."],
      { label: "Confirm reset request", url: d.url }),

  mfaResetScheduled: (b: Branding, d: { eligibleAt: string; cancelUrl: string }) =>
    render(b, "Two-factor reset scheduled", "Two-factor reset scheduled",
      [`Two-factor authentication will be removable from your account after ${d.eligibleAt} (UTC).`, "If you did not request this, cancel it now. Cancelling keeps two-factor authentication on."],
      { label: "Cancel the reset", url: d.cancelUrl }),

  mfaResetCompleted: (b: Branding, d: { resetUrl: string }) =>
    render(b, "Two-factor authentication removed", "Two-factor authentication removed",
      ["Two-factor authentication was removed after the waiting period. All other sessions were signed out. Set up two-factor authentication again from your security settings.", `If this wasn't you, reset your password immediately: ${d.resetUrl}`]),

  invitation: (b: Branding, d: { orgName: string; inviterName: string; roleName: string; url: string; expiresAt: string }) =>
    render(b, `You're invited to ${d.orgName}`, `Join ${d.orgName}`,
      [`${d.inviterName} invited you to join ${d.orgName} on ${b.productName} as ${d.roleName}.`, `This invitation expires on ${d.expiresAt} (UTC).`],
      { label: "Accept invitation", url: d.url }),

  transferRequested: (b: Branding, d: { host: string; respondBy: string; url: string }) =>
    render(b, `Ownership transfer requested for ${d.host}`, "Domain ownership transfer requested",
      [`Another organization has proved DNS control of ${d.host} and asked to take over its monitoring.`, `A platform administrator will review the request. If you still own this domain, contest it before ${d.respondBy} (UTC) from the website's page.`, "Your monitoring data is never shared with the other organization."],
      { label: "Review the request", url: d.url }),

  transferDecided: (b: Branding, d: { host: string; approved: boolean; forRequester: boolean; url: string }) =>
    render(b, `Ownership transfer ${d.approved ? "approved" : "rejected"} for ${d.host}`, `Transfer ${d.approved ? "approved" : "rejected"}`,
      [d.forRequester
        ? (d.approved ? `${d.host} is now registered to your organization. Install the monitoring script to start collecting data.` : `Your request to take over ${d.host} was rejected after review.`)
        : (d.approved ? `${d.host} has been transferred to another organization that proved ownership. The website was archived in your organization; its data was not shared.` : `The transfer request for ${d.host} was rejected. Nothing changed.`)],
      { label: "Open websites", url: d.url }),

  ownershipFailing: (b: Branding, d: { host: string; method: string; lapsesAt: string; url: string }) =>
    render(b, `Ownership check failing for ${d.host}`, "We couldn't confirm you still own this domain",
      [`Our periodic check of ${d.host} couldn't find your ${d.method}. Monitoring continues for now.`, `Restore the record or file before ${d.lapsesAt} (UTC), or monitoring will be paused. Temporary outages don't count against you.`],
      { label: "Review verification", url: d.url }),
  ownershipLapsed: (b: Branding, d: { host: string; releaseAt: string; url: string }) =>
    render(b, `Monitoring paused for ${d.host}`, "Ownership verification lapsed",
      [`We still can't confirm that you control ${d.host}, so monitoring is paused.`, `Restore the verification record and run a check to resume. If ownership can't be confirmed by ${d.releaseAt} (UTC), the domain is released from your organization.`],
      { label: "Restore verification", url: d.url }),
  ownershipRestored: (b: Branding, d: { host: string; url: string }) =>
    render(b, `Ownership confirmed for ${d.host}`, "Ownership confirmed",
      [`We confirmed that you control ${d.host} again. Monitoring is active.`], { label: "Open website", url: d.url }),
  ownershipLost: (b: Branding, d: { host: string; url: string }) =>
    render(b, `${d.host} released from your organization`, "Domain released",
      [`Ownership of ${d.host} couldn't be confirmed for an extended period, so the website was archived and the domain released. Its history is kept for your records.`, "If you still own the domain, add it again and verify it."],
      { label: "Open websites", url: d.url }),

  incidentOpened: (b: Branding, d: { site: string; host: string; number: number; title: string; description: string; severity: string; since: string; url: string }) =>
    render(b, `[${d.severity}] ${d.title}: ${d.site}`, `${d.title} (INC-${d.number})`,
      [`${d.site} (${d.host}): ${d.description}.`, `Detected since ${d.since} (UTC) by our synthetic HTTP check. We'll tell you when it recovers; you won't get an email for every failed check.`],
      { label: "Open incident", url: d.url }),
  incidentResolved: (b: Branding, d: { site: string; host: string; number: number; title: string; duration: string; at: string; url: string }) =>
    render(b, `Recovered: ${d.title}: ${d.site}`, `Recovered (INC-${d.number})`,
      [`${d.site} (${d.host}) passed its checks again at ${d.at} (UTC).`, `The problem lasted about ${d.duration}.`],
      { label: "Open incident", url: d.url }),
  sslExpiring: (b: Branding, d: { site: string; host: string; days: number; validTo: string; url: string }) =>
    render(b, `TLS certificate for ${d.host} expires in ${d.days} day${d.days === 1 ? "" : "s"}`, "Certificate expiring soon",
      [`The TLS certificate served by ${d.host} (${d.site}) expires on ${d.validTo} (UTC).`, "Renew it before then, or visitors will see a security warning and the site will be reported as unavailable."],
      { label: "Open website", url: d.url }),
  monitoringInterrupted: (b: Branding, d: { site: string; host: string; checks: number; url: string }) =>
    render(b, `Monitoring of ${d.host} is interrupted`, "Monitoring interrupted on our side",
      [`Our last ${d.checks} checks of ${d.site} couldn't be completed because of a problem in our monitoring infrastructure, not your website.`, "These checks don't count against your uptime. We're working on it."],
      { label: "Open website", url: d.url }),

  /** Phase 4H: platform self-alert for operators (aggregate operational data only — never customer data). */
  platformAlert: (b: Branding, d: { event: string; severity: string; rule: string; component: string; reason: string; since: string; occurrences: number; url: string }) =>
    render(b, `[${d.event === "RECOVERED" ? "RECOVERED" : d.severity}] ${b.productName} platform: ${d.rule} (${d.component})`,
      d.event === "RECOVERED" ? "Platform alert recovered" : d.event === "RENOTIFY" ? "Platform alert still open" : "Platform alert",
      [`${d.reason}`, `Component: ${d.component} · rule: ${d.rule} · since ${d.since} (UTC) · seen ${d.occurrences} time(s).`,
        d.event === "RECOVERED" ? "No action is needed." : "Acknowledge it in the Super Admin console to stop repeat notifications."],
      { label: "Open platform alerts", url: d.url }),

  accountLocked: (b: Branding, d: { minutes: number; resetUrl: string }) =>
    render(b, "Sign-in temporarily locked", "Too many failed sign-in attempts",
      [`Because of repeated failed sign-in attempts, signing in to your account is paused for ${d.minutes} minutes.`, `If this wasn't you, consider resetting your password: ${d.resetUrl}`]),
} as const;

export type TemplateName = keyof typeof templates;
