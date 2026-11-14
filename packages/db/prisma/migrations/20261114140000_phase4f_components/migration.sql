-- AlterEnum
ALTER TYPE "ComponentType" ADD VALUE 'CARD_GROUP';

-- AlterTable
ALTER TABLE "component_test_results" ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "safety" TEXT,
ADD COLUMN     "target" TEXT,
ADD COLUMN     "test_kind" TEXT;

-- AlterTable
ALTER TABLE "page_components" ADD COLUMN     "detail" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "detail_hash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "label" TEXT,
ADD COLUMN     "last_execution_id" UUID,
ADD COLUMN     "missed_runs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "removed_at" TIMESTAMPTZ(6),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PRESENT',
ADD COLUMN     "viewports" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "website_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "responsive_test_results" ADD COLUMN     "obscured_controls" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "offscreen_controls" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "component_events" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "page_component_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "component_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "component_events_website_id_created_at_idx" ON "component_events"("website_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "component_events_page_component_id_execution_id_type_key" ON "component_events"("page_component_id", "execution_id", "type");

-- CreateIndex
CREATE INDEX "component_test_results_website_id_tested_at_idx" ON "component_test_results"("website_id", "tested_at" DESC);

-- CreateIndex
CREATE INDEX "component_test_results_execution_id_idx" ON "component_test_results"("execution_id");

-- CreateIndex
CREATE INDEX "page_components_website_id_status_idx" ON "page_components"("website_id", "status");

-- AddForeignKey
ALTER TABLE "component_events" ADD CONSTRAINT "component_events_page_component_id_fkey" FOREIGN KEY ("page_component_id") REFERENCES "page_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

