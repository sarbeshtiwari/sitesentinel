-- AlterTable
ALTER TABLE "worker_heartbeats" ADD COLUMN     "deps" JSONB,
ADD COLUMN     "failed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_job_at" TIMESTAMPTZ(6),
ADD COLUMN     "meta" JSONB,
ADD COLUMN     "processed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timeouts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "platform_health" (
    "component" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "since" TIMESTAMPTZ(6) NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
    "evaluated_by" TEXT NOT NULL,

    CONSTRAINT "platform_health_pkey" PRIMARY KEY ("component")
);

-- CreateTable
CREATE TABLE "platform_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fingerprint" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by_id" UUID,
    "recovered_at" TIMESTAMPTZ(6),
    "suppressed_by" UUID,
    "last_notified_at" TIMESTAMPTZ(6),
    "notify_state" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "platform_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_alert_events" (
    "id" BIGSERIAL NOT NULL,
    "alert_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "actor_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "platform_alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_reconciliation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "requested_by_id" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "stats" JSONB,
    "error" TEXT,

    CONSTRAINT "usage_reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_discrepancies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "check" TEXT NOT NULL,
    "key" TEXT,
    "recorded" BIGINT NOT NULL,
    "expected" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution" TEXT,

    CONSTRAINT "usage_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "key" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "discrepancy_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_alerts_state_opened_at_idx" ON "platform_alerts"("state", "opened_at");

-- CreateIndex
CREATE INDEX "platform_alerts_fingerprint_opened_at_idx" ON "platform_alerts"("fingerprint", "opened_at");

-- CreateIndex
CREATE INDEX "platform_alert_events_alert_id_at_idx" ON "platform_alert_events"("alert_id", "at");

-- CreateIndex
CREATE INDEX "usage_reconciliation_runs_day_requested_at_idx" ON "usage_reconciliation_runs"("day", "requested_at");

-- CreateIndex
CREATE INDEX "usage_discrepancies_run_id_idx" ON "usage_discrepancies"("run_id");

-- CreateIndex
CREATE INDEX "usage_discrepancies_org_id_day_idx" ON "usage_discrepancies"("org_id", "day");

-- CreateIndex
CREATE INDEX "usage_adjustments_org_id_day_idx" ON "usage_adjustments"("org_id", "day");

-- AddForeignKey
ALTER TABLE "platform_alert_events" ADD CONSTRAINT "platform_alert_events_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "platform_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_discrepancies" ADD CONSTRAINT "usage_discrepancies_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "usage_reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

