-- AlterTable
ALTER TABLE "domain_claims" ADD COLUMN     "inherited_from_claim_id" UUID,
ADD COLUMN     "last_attempt_at" TIMESTAMPTZ(6),
ADD COLUMN     "token_issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "verification_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verified_method" "VerificationMethod";

-- AlterTable
ALTER TABLE "domain_registration_attempts" ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "domain_transfers" ADD COLUMN     "applied_at" TIMESTAMPTZ(6),
ADD COLUMN     "from_org_id" UUID,
ADD COLUMN     "last_check_detail" JSONB,
ADD COLUMN     "requested_by_id" UUID,
ADD COLUMN     "to_website_id" UUID,
ADD COLUMN     "token_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "verification_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verification_token" TEXT,
ADD COLUMN     "verified_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "domain_verifications" ADD COLUMN     "org_id" UUID,
ADD COLUMN     "scope_granted" "ClaimScope";

-- AlterTable
ALTER TABLE "site_installations" ADD COLUMN     "heartbeat_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "key_created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "last_check" JSONB,
ADD COLUMN     "last_checked_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_invalid_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_invalid_origin" TEXT,
ADD COLUMN     "last_invalid_reason" TEXT,
ADD COLUMN     "revoked_at" TIMESTAMPTZ(6),
ADD COLUMN     "telemetry_paused" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "trials" ALTER COLUMN "plan_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "websites" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "monitoring_timezone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN     "trial_outcome" TEXT,
ADD COLUMN     "verified_at" TIMESTAMPTZ(6);
