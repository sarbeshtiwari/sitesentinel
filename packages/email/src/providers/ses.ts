import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EmailSendError, type EmailMessage, type EmailProvider, type SendResult } from "../provider.js";

/**
 * Amazon SES v2. Credentials come from the default AWS chain (instance role,
 * env) — never from the database. Region defaults to Mumbai (ap-south-1).
 */
export class SesEmailProvider implements EmailProvider {
  readonly name = "ses";

  constructor(
    private readonly client: Pick<SESv2Client, "send"> = new SESv2Client({ region: process.env.AWS_REGION ?? "ap-south-1" }),
    private readonly configurationSet?: string,
  ) {}

  async send(m: EmailMessage): Promise<SendResult> {
    const cmd = new SendEmailCommand({
      FromEmailAddress: m.from,
      Destination: { ToAddresses: [m.to] },
      ReplyToAddresses: m.replyTo ? [m.replyTo] : undefined,
      ConfigurationSetName: this.configurationSet,
      EmailTags: m.tags ? Object.entries(m.tags).map(([Name, Value]) => ({ Name, Value })) : undefined,
      Content: {
        Simple: {
          Subject: { Data: m.subject, Charset: "UTF-8" },
          Body: { Html: { Data: m.html, Charset: "UTF-8" }, Text: { Data: m.text, Charset: "UTF-8" } },
          Headers: m.idempotencyKey ? [{ Name: "X-Entity-Ref-ID", Value: m.idempotencyKey }] : undefined,
        },
      },
    });
    try {
      const out = await this.client.send(cmd);
      return { provider: this.name, providerMessageId: out.MessageId ?? null };
    } catch (e) {
      const err = e as { name?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
      const status = err.$metadata?.httpStatusCode ?? 0;
      const retryable = Boolean(err.$retryable) || status === 429 || status >= 500 || status === 0;
      throw new EmailSendError(`ses send failed: ${err.name ?? "error"}`, retryable);
    }
  }
}
