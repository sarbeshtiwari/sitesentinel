-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "deep_scans_org_id_updated_at_idx" ON "deep_scans"("org_id", "updated_at");

-- CreateIndex
CREATE INDEX "execution_results_org_id_window_start_idx" ON "execution_results"("org_id", "window_start" DESC);

-- CreateIndex
CREATE INDEX "execution_results_org_id_recorded_at_idx" ON "execution_results"("org_id", "recorded_at");

-- CreateIndex
CREATE INDEX "incident_events_org_id_created_at_idx" ON "incident_events"("org_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "incidents_org_id_last_detected_at_id_idx" ON "incidents"("org_id", "last_detected_at" DESC, "id");

