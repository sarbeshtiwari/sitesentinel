-- AlterTable
ALTER TABLE "monitoring_configurations" ALTER COLUMN "t1_interval_sec" DROP NOT NULL,
ALTER COLUMN "t1_interval_sec" DROP DEFAULT;


-- The Phase 1 default (300) was never a customer choice: no API or UI ever set it. Rows carrying it
-- would silently slow HTTP checks to 5 minutes, so they revert to the entitled default.
UPDATE "monitoring_configurations" SET "t1_interval_sec" = NULL WHERE "t1_interval_sec" = 300;
