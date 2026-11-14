export interface EmailMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** Provider-side dedupe key (Resend Idempotency-Key, SES/SMTP header). */
  idempotencyKey?: string;
  tags?: Record<string, string>;
}

export interface SendResult {
  provider: string;
  providerMessageId: string | null;
}

/** Provider-independent email transport. Business code depends only on this interface. */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<SendResult>;
  /** Phase 4H: cheap reachability check for health reporting (no message sent). Optional: HTTP APIs have none. */
  verify?(): Promise<void>;
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    /** false for permanent failures (invalid address, auth) that must not be retried */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}
