-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExecutionStatus" ADD VALUE 'SCHEDULED';
ALTER TYPE "ExecutionStatus" ADD VALUE 'RETRYING';
ALTER TYPE "ExecutionStatus" ADD VALUE 'DEAD_LETTERED';

-- AlterTable
ALTER TABLE "job_failures" ADD COLUMN     "execution_id" UUID,
ADD COLUMN     "failure_category" TEXT,
ADD COLUMN     "job_type" TEXT,
ADD COLUMN     "replay_execution_id" UUID,
ADD COLUMN     "replay_reason" TEXT,
ADD COLUMN     "replay_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "replay_requested_by_id" UUID,
ADD COLUMN     "website_id" UUID;

-- AlterTable
ALTER TABLE "monitoring_executions" ADD COLUMN     "cancel_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "enqueued_at" TIMESTAMPTZ(6),
ADD COLUMN     "failure_category" TEXT,
ADD COLUMN     "lease_expires_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "monitoring_schedules" ADD COLUMN     "paused_reason" TEXT;

-- CreateIndex
CREATE INDEX "monitoring_executions_org_id_status_idx" ON "monitoring_executions"("org_id", "status");
