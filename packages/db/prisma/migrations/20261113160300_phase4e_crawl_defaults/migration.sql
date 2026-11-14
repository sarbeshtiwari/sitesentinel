-- AlterTable
ALTER TABLE "monitoring_configurations" ALTER COLUMN "max_pages" DROP NOT NULL,
ALTER COLUMN "max_pages" DROP DEFAULT,
ALTER COLUMN "max_depth" DROP NOT NULL,
ALTER COLUMN "max_depth" DROP DEFAULT;


-- The Phase 1 defaults (25 pages, depth 3) were never customer choices — no API ever set them — but would cap
-- every plan's limits. Rows still carrying them revert to "use the plan limit".
UPDATE "monitoring_configurations" SET "max_pages" = NULL WHERE "max_pages" = 25;
UPDATE "monitoring_configurations" SET "max_depth" = NULL WHERE "max_depth" = 3;
