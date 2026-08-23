-- AdLens — drop the hackathon demo dataset.
--
-- These five tables held the seeded portfolio: 55 invented campaigns, four
-- flagship ad sets, twelve ads, five recommendations and three alerts. They
-- were the CP1 demo fixture and nothing reads them any more — the app now
-- shows only what was synced from the Graph API or uploaded from a report,
-- all of which lives in the meta_* tables and is untouched by this file.
--
-- Run it once in Neon's SQL Editor. It is irreversible: take a Neon branch
-- first if you want the demo portfolio recoverable.
--
-- What this does NOT touch, to be explicit:
--   meta_campaigns, meta_daily_metrics, meta_adsets, meta_adset_daily,
--   meta_ads, meta_ad_daily, upload_batches, sync_log, meta_connections
-- Those hold your real synced and uploaded data.

BEGIN;

DROP TABLE IF EXISTS ads CASCADE;
DROP TABLE IF EXISTS adsets CASCADE;
DROP TABLE IF EXISTS recommendations CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS campaigns CASCADE;

COMMIT;

-- Confirm they are gone and the real tables are not.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
