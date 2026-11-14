import { EmailSendError, type EmailMessage, type EmailProvider, type SendResult } from "../provider.js";

/** Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.resend.com",
    private readonly timeoutMs = 10_000,
  ) {
    if (!apiKey) throw new Error("RESEND_API_KEY is required for the resend provider");
  }

  async send(m: EmailMessage): Promise<SendResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (m.idempotencyKey) headers["Idempotency-Key"] = m.idempotencyKey;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/emails`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: m.from,
          to: [m.to],
          reply_to: m.replyTo,
          subject: m.subject,
          html: m.html,
          text: m.text,
          tags: m.tags ? Object.entries(m.tags).map(([name, value]) => ({ name, value })) : undefined,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new EmailSendError(`resend request failed: ${(e as Error).message}`, true);
    }
    if (!res.ok) {
      // 4xx other than 429 are permanent (bad address, auth, validation).
      const retryable = res.status === 429 || res.status >= 500;
      throw new EmailSendError(`resend responded ${res.status}`, retryable);
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { provider: this.name, providerMessageId: body.id ?? null };
  }
}
