-- AlterTable
ALTER TABLE "domain_claims" ADD COLUMN     "failing_since" TIMESTAMPTZ(6),
ADD COLUMN     "last_revalidation_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_revalidation_outcome" TEXT,
ADD COLUMN     "next_revalidation_at" TIMESTAMPTZ(6),
ADD COLUMN     "revalidation_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "revalidation_state" TEXT NOT NULL DEFAULT 'OK',
ADD COLUMN     "transient_failures" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "domain_claims_status_next_revalidation_at_idx" ON "domain_claims"("status", "next_revalidation_at");
