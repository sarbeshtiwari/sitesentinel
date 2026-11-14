-- AlterTable
ALTER TABLE "artifacts" ADD COLUMN     "purpose" TEXT,
ADD COLUMN     "viewport" TEXT;

-- AlterTable
ALTER TABLE "monitoring_configurations" ADD COLUMN     "browser_check" JSONB;

-- AlterTable
ALTER TABLE "page_test_results" ADD COLUMN     "attempt" INTEGER,
ADD COLUMN     "available" BOOLEAN,
ADD COLUMN     "details" JSONB,
ADD COLUMN     "failure_category" TEXT,
ADD COLUMN     "failure_kind" TEXT,
ADD COLUMN     "final_url" TEXT,
ADD COLUMN     "finished_at" TIMESTAMPTZ(6),
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "navigation" JSONB,
ADD COLUMN     "network" JSONB,
ADD COLUMN     "page_path" TEXT,
ADD COLUMN     "rendering" JSONB,
ADD COLUMN     "scripts" JSONB,
ADD COLUMN     "started_at" TIMESTAMPTZ(6),
ADD COLUMN     "width" INTEGER,
ALTER COLUMN "monitored_page_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "performance_metrics" ADD COLUMN     "long_tasks" INTEGER,
ADD COLUMN     "navigation_timing" JSONB,
ADD COLUMN     "page_path" TEXT,
ALTER COLUMN "monitored_page_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "responsive_test_results" ADD COLUMN     "page_path" TEXT,
ALTER COLUMN "monitored_page_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "execution_results" (
    "execution_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "tier" "CheckTier" NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "outcome" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_results_pkey" PRIMARY KEY ("execution_id")
);

-- CreateIndex
CREATE INDEX "execution_results_website_id_tier_window_start_idx" ON "execution_results"("website_id", "tier", "window_start" DESC);

-- CreateIndex
CREATE INDEX "execution_results_recorded_at_idx" ON "execution_results"("recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "page_test_results_execution_id_viewport_tested_at_key" ON "page_test_results"("execution_id", "viewport", "tested_at");

-- CreateIndex
CREATE INDEX "performance_metrics_website_id_measured_at_idx" ON "performance_metrics"("website_id", "measured_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "performance_metrics_execution_id_viewport_measured_at_key" ON "performance_metrics"("execution_id", "viewport", "measured_at");

-- CreateIndex
CREATE INDEX "responsive_test_results_website_id_tested_at_idx" ON "responsive_test_results"("website_id", "tested_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "responsive_test_results_execution_id_viewport_tested_at_key" ON "responsive_test_results"("execution_id", "viewport", "tested_at");


-- Existing results join the ledger, so executions already recorded can never record again.
INSERT INTO "execution_results" (execution_id, org_id, website_id, tier, window_start, outcome, attempt, recorded_at)
SELECT DISTINCT ON (execution_id) execution_id, org_id, website_id, 'T1_HTTP', checked_at, status::text, coalesce(attempt, 1), coalesce(finished_at, checked_at)
  FROM "check_results" ORDER BY execution_id, checked_at
ON CONFLICT (execution_id) DO NOTHING;
