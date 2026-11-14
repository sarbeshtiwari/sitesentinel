import nodemailer, { type Transporter } from "nodemailer";
import { EmailSendError, type EmailMessage, type EmailProvider, type SendResult } from "../provider.js";

/** SMTP transport: Mailpit in development, or any SMTP relay. */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private readonly transport: Transporter;

  constructor(opts: { host: string; port: number; secure?: boolean; user?: string; pass?: string }) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure ?? false,
      auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async verify(): Promise<void> {
    await this.transport.verify();
  }

  async send(m: EmailMessage): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: m.from,
        to: m.to,
        replyTo: m.replyTo,
        subject: m.subject,
        html: m.html,
        text: m.text,
        headers: m.idempotencyKey ? { "X-Entity-Ref-ID": m.idempotencyKey } : undefined,
      });
      return { provider: this.name, providerMessageId: info.messageId ?? null };
    } catch (e) {
      const code = (e as { responseCode?: number }).responseCode ?? 0;
      // SMTP 4xx replies are transient, 5xx are permanent; no reply code = connection problem (transient).
      throw new EmailSendError(`smtp send failed: ${(e as Error).message}`, code === 0 || (code >= 400 && code < 500));
    }
  }
}
