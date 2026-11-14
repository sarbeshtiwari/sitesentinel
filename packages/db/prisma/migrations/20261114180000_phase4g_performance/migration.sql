-- AlterTable
ALTER TABLE "metrics_daily" ADD COLUMN     "p75" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "metrics_hourly" ADD COLUMN     "p75" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "rollup_state" (
    "name" TEXT NOT NULL,
    "watermark" TIMESTAMPTZ(6) NOT NULL,
    "last_run_at" TIMESTAMPTZ(6) NOT NULL,
    "last_stats" JSONB,

    CONSTRAINT "rollup_state_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "metrics_daily_org_id_metric_bucket_idx" ON "metrics_daily"("org_id", "metric", "bucket");

-- CreateIndex
CREATE INDEX "metrics_hourly_org_id_metric_bucket_idx" ON "metrics_hourly"("org_id", "metric", "bucket");

-- CreateIndex
CREATE INDEX "performance_metrics_org_id_measured_at_idx" ON "performance_metrics"("org_id", "measured_at" DESC);

