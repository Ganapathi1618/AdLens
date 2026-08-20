-- AdLens — uploaded reports.
--
-- You do NOT need to run this. lib/uploads.ts creates everything below on the
-- first upload, including the meta_* tables, so a database that has never
-- synced Meta works for uploads out of the box. This file is here as the
-- reference for what an upload actually writes, and to let you provision the
-- schema ahead of time if you prefer explicit migrations.
--
-- Every statement is idempotent and additive; running it changes nothing that
-- already exists.

-- ── How an uploaded report is stored ────────────────────────────────
-- An upload is a synthetic AD ACCOUNT living in the same meta_* tables the
-- Graph API sync writes to, scoped by meta_campaigns.ad_account_id.
--
--   * Upload account ids are "up" + 12 hex characters. Real Meta ad account
--     ids are digits only, so the two can never collide, and a sync can never
--     be pointed at an uploaded batch.
--   * meta_campaigns.data_source is 'upload' for these rows and 'graph' for
--     synced ones, so provenance survives into the UI and the AI narrative.
--   * Deleting a batch deletes its campaigns; ad sets, ads and every daily row
--     cascade from there.

CREATE TABLE IF NOT EXISTS upload_batches (
  id             TEXT PRIMARY KEY,          -- also the synthetic ad_account_id
  label          TEXT NOT NULL,             -- what the picker shows
  filename       TEXT NOT NULL,
  sheet          TEXT,                      -- .xlsx sheet the rows came from
  currency       TEXT NOT NULL DEFAULT 'USD',
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  level          TEXT NOT NULL DEFAULT 'campaign',   -- ad | adset | campaign
  granularity    TEXT NOT NULL DEFAULT 'snapshot',   -- daily | snapshot
  tier           TEXT NOT NULL DEFAULT 'snapshot',   -- full | trends | snapshot
  date_start     DATE,
  date_end       DATE,
  distinct_days  INT DEFAULT 0,
  rows_parsed    INT DEFAULT 0,
  campaigns      INT DEFAULT 0,
  adsets         INT DEFAULT 0,
  ads            INT DEFAULT 0,
  day_rows       INT DEFAULT 0,
  capabilities   JSONB DEFAULT '[]'::jsonb,  -- what this file can/cannot support, and why
  warnings       JSONB DEFAULT '[]'::jsonb,
  mapping        JSONB DEFAULT '{}'::jsonb,  -- confirmed column mapping
  unmapped       JSONB DEFAULT '[]'::jsonb,  -- columns deliberately ignored
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Marks which rows came from a file rather than the Graph API.
ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS data_source TEXT DEFAULT 'graph';

SELECT 'upload tables ready' AS status;
