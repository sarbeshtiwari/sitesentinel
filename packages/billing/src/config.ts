import { openString, sealedKeyVersion, type KeyProvider } from "@wim/crypto";
import type { Db, Tx } from "@wim/db";
import { RazorpayGateway } from "./razorpay.js";
import { StripeGateway } from "./stripe.js";
import type { FetchLike, GatewayCredentials, GatewayKind, PaymentGateway } from "./types.js";

/** Envelope-encryption purpose and AAD of payment_gateway_configs.secrets_enc (platform DEK, KEK outside the DB). */
export const GATEWAY_SECRET_PURPOSE = "platform-config" as const;
export const gatewaySecretAad = (g: GatewayKind) => `payment_gateway_configs.secrets:${g}`;

export interface StoredGatewaySecrets { secretKey: string; webhookSecret: string }

export type SecretOpener = (blob: Buffer, aad: string) => Promise<string>;

export interface LoadedGateway {
  kind: GatewayKind;
  enabled: boolean;
  mode: "test" | "live";
  currencies: string[];
  credentials: GatewayCredentials | null;
}

/** Read and decrypt one gateway's configuration. Secrets stay in memory only. */
export async function loadGatewayConfig(db: Db | Tx, kind: GatewayKind, open: SecretOpener): Promise<LoadedGateway | null> {
  const row = await db.paymentGatewayConfig.findUnique({ where: { gateway: kind }, omit: { secretsEnc: false } } as never) as
    { enabled: boolean; mode: string; publicKey: string | null; currencies: string[]; secretsEnc: Uint8Array | null } | null;
  if (!row) return null;
  let credentials: GatewayCredentials | null = null;
  if (row.secretsEnc) {
    const s = JSON.parse(await open(Buffer.from(row.secretsEnc), gatewaySecretAad(kind))) as StoredGatewaySecrets;
    if (s.secretKey && s.webhookSecret) credentials = { secretKey: s.secretKey, webhookSecret: s.webhookSecret, publicKey: row.publicKey, mode: row.mode === "live" ? "live" : "test" };
  }
  return { kind, enabled: row.enabled, mode: row.mode === "live" ? "live" : "test", currencies: row.currencies, credentials };
}

export interface GatewayEndpoints { fetchImpl?: FetchLike; stripeBaseUrl?: string; razorpayBaseUrl?: string }

export function createGateway(kind: GatewayKind, creds: GatewayCredentials, ep: GatewayEndpoints = {}): PaymentGateway {
  return kind === "STRIPE" ? new StripeGateway(creds, ep.fetchImpl, ep.stripeBaseUrl) : new RazorpayGateway(creds, ep.fetchImpl, ep.razorpayBaseUrl);
}

/**
 * Decrypt with a platform data key, for processes without the API's KeysService (the scheduler's reconciliation).
 * Same scheme as apps/api KeysService.openPlatform: wrapped DEK in platform_data_keys, unwrapped by the KEK provider.
 */
export function platformSecretOpener(db: Db | Tx, provider: KeyProvider): SecretOpener {
  return async (blob, aad) => {
    const version = sealedKeyVersion(blob);
    const row = await db.platformDataKey.findUniqueOrThrow({ where: { purpose_version: { purpose: GATEWAY_SECRET_PURPOSE, version } } });
    const dek = await provider.unwrapKey(row.kekId, Buffer.from(row.wrappedDek), `platform:${GATEWAY_SECRET_PURPOSE}:v${version}`);
    try { return openString(dek, blob, aad); } finally { dek.fill(0); }
  };
}

/** Short, non-reversible hint shown to admins ("sk_test_…a1b2"). */
export function secretHint(secretKey: string): string {
  const prefix = secretKey.match(/^(sk|rk)_(test|live)_/)?.[0] ?? secretKey.match(/^rzp_(test|live)_/)?.[0] ?? "";
  return `${prefix}…${secretKey.slice(-4)}`;
}
