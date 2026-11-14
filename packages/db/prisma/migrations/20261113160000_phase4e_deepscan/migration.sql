-- AlterTable
ALTER TABLE "monitoring_configurations" ADD COLUMN     "deep_scan" JSONB;

-- CreateTable
CREATE TABLE "deep_scans" (
    "execution_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'SCHEDULE',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "stop_reason" TEXT,
    "config" JSONB NOT NULL,
    "discovery" JSONB,
    "pages_discovered" INTEGER NOT NULL DEFAULT 0,
    "pages_completed" INTEGER NOT NULL DEFAULT 0,
    "pages_failed" INTEGER NOT NULL DEFAULT 0,
    "pages_skipped" INTEGER NOT NULL DEFAULT 0,
    "pages_inconclusive" INTEGER NOT NULL DEFAULT 0,
    "resources_checked" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "browser_ms" INTEGER NOT NULL DEFAULT 0,
    "findings_opened" INTEGER NOT NULL DEFAULT 0,
    "findings_resolved" INTEGER NOT NULL DEFAULT 0,
    "comparison" JSONB,
    "baseline_execution_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "deep_scans_pkey" PRIMARY KEY ("execution_id")
);

-- CreateTable
CREATE TABLE "deep_scan_urls" (
    "id" BIGSERIAL NOT NULL,
    "execution_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "url_hash" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "resource_type" TEXT,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "skip_reason" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "in_sitemap" BOOLEAN NOT NULL DEFAULT false,
    "referrers" INTEGER NOT NULL DEFAULT 0,
    "first_referrer" TEXT,
    "status_code" INTEGER,
    "final_url" TEXT,
    "redirect_chain" JSONB,
    "content_type" TEXT,
    "bytes" INTEGER,
    "duration_ms" INTEGER,
    "facts" JSONB,
    "error" TEXT,
    "checked_at" TIMESTAMPTZ(6),

    CONSTRAINT "deep_scan_urls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_findings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "group_key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "subject" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "recommendation" TEXT NOT NULL,
    "detection_method" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT true,
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "first_detected_at" TIMESTAMPTZ(6) NOT NULL,
    "last_detected_at" TIMESTAMPTZ(6) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "first_execution_id" UUID NOT NULL,
    "last_execution_id" UUID NOT NULL,
    "resolved_execution_id" UUID,

    CONSTRAINT "scan_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_finding_events" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_finding_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deep_scans_website_id_started_at_idx" ON "deep_scans"("website_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "deep_scans_org_id_status_idx" ON "deep_scans"("org_id", "status");

-- CreateIndex
CREATE INDEX "deep_scan_urls_execution_id_state_kind_depth_idx" ON "deep_scan_urls"("execution_id", "state", "kind", "depth");

-- CreateIndex
CREATE UNIQUE INDEX "deep_scan_urls_execution_id_url_hash_key" ON "deep_scan_urls"("execution_id", "url_hash");

-- CreateIndex
CREATE INDEX "scan_findings_org_id_website_id_status_severity_idx" ON "scan_findings"("org_id", "website_id", "status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "scan_findings_website_id_fingerprint_key" ON "scan_findings"("website_id", "fingerprint");

-- CreateIndex
CREATE INDEX "scan_finding_events_finding_id_created_at_idx" ON "scan_finding_events"("finding_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "scan_finding_events_finding_id_execution_id_type_key" ON "scan_finding_events"("finding_id", "execution_id", "type");

-- AddForeignKey
ALTER TABLE "deep_scan_urls" ADD CONSTRAINT "deep_scan_urls_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "deep_scans"("execution_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The Phase 1 column default IGNORE_ALL would drop every query parameter, merging distinct pages
-- (e.g. /products?category=shoes). No API ever set it, so rows still carrying it revert to the 4E default.
ALTER TABLE "monitoring_configurations" ALTER COLUMN "query_param_mode" SET DEFAULT 'KEEP_MEANINGFUL';
UPDATE "monitoring_configurations" SET "query_param_mode" = 'KEEP_MEANINGFUL' WHERE "query_param_mode" = 'IGNORE_ALL';
