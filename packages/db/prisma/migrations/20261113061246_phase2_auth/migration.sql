-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMPTZ(6),
ADD COLUMN     "totp_last_used_step" BIGINT;

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "accepted_at" TIMESTAMPTZ(6),
ADD COLUMN     "accepted_by_id" UUID,
ADD COLUMN     "last_sent_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totp_last_used_step" BIGINT,
ADD COLUMN     "totp_pending_secret_enc" BYTEA;

-- CreateTable
CREATE TABLE "account_recovery_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MFA_RESET',
    "status" TEXT NOT NULL DEFAULT 'PENDING_EMAIL',
    "confirm_token_hash" TEXT,
    "cancel_token_hash" TEXT,
    "confirm_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "eligible_at" TIMESTAMPTZ(6),
    "ip_prefix" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "account_recovery_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_data_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "purpose" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kek_id" TEXT NOT NULL,
    "wrapped_dek" BYTEA NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(6),

    CONSTRAINT "platform_data_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_recovery_requests_confirm_token_hash_key" ON "account_recovery_requests"("confirm_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "account_recovery_requests_cancel_token_hash_key" ON "account_recovery_requests"("cancel_token_hash");

-- CreateIndex
CREATE INDEX "account_recovery_requests_user_id_status_idx" ON "account_recovery_requests"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_data_keys_purpose_version_key" ON "platform_data_keys"("purpose", "version");

-- CreateIndex
CREATE INDEX "invitations_org_id_email_status_idx" ON "invitations"("org_id", "email", "status");

-- AddForeignKey
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
