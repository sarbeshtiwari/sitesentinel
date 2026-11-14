import type { EmailProvider } from "./provider.js";
import { ResendEmailProvider } from "./providers/resend.js";
import { SesEmailProvider } from "./providers/ses.js";
import { SmtpEmailProvider } from "./providers/smtp.js";

export * from "./provider.js";
export * from "./templates/index.js";
export { ResendEmailProvider, SesEmailProvider, SmtpEmailProvider };

/**
 * Select the provider from environment configuration:
 *   EMAIL_PROVIDER=smtp   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS  (dev: Mailpit)
 *   EMAIL_PROVIDER=resend RESEND_API_KEY
 *   EMAIL_PROVIDER=ses    AWS_REGION (default ap-south-1), SES_CONFIGURATION_SET; credentials via AWS chain
 */
export function createEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  switch (env.EMAIL_PROVIDER ?? "smtp") {
    case "resend":
      return new ResendEmailProvider(env.RESEND_API_KEY ?? "");
    case "ses":
      return new SesEmailProvider(undefined, env.SES_CONFIGURATION_SET);
    case "smtp":
      return new SmtpEmailProvider({
        host: env.SMTP_HOST ?? "127.0.0.1",
        port: Number(env.SMTP_PORT ?? 1025),
        secure: env.SMTP_SECURE === "true",
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      });
    default:
      throw new Error(`Unknown EMAIL_PROVIDER: ${env.EMAIL_PROVIDER}`);
  }
}
