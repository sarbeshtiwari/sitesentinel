-- AlterTable
ALTER TABLE "check_results" ADD COLUMN     "attempt" INTEGER,
ADD COLUMN     "available" BOOLEAN,
ADD COLUMN     "content_type" TEXT,
ADD COLUMN     "details" JSONB,
ADD COLUMN     "failure_category" TEXT,
ADD COLUMN     "final_url" TEXT,
ADD COLUMN     "finished_at" TIMESTAMPTZ(6),
ADD COLUMN     "method" TEXT,
ADD COLUMN     "response_headers" JSONB,
ADD COLUMN     "started_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "monitoring_configurations" ADD COLUMN     "http_check" JSONB;

-- AlterTable
ALTER TABLE "monitoring_schedules" ADD COLUMN     "state" JSONB,
ADD COLUMN     "state_window_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "dedupe_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "check_results_execution_id_checked_at_key" ON "check_results"("execution_id", "checked_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedupe_key_key" ON "outbox_events"("dedupe_key");

