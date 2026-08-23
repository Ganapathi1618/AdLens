// ── Uploaded reports: schema and persistence ────────────────────────
// An uploaded report is stored as a synthetic AD ACCOUNT in the same meta_*
// tables the Graph API sync writes to, scoped by `ad_account_id`.
//
// That is a deliberate choice, not a shortcut. Every live read in lib/meta.ts
// is already scoped by ad account, so an upload reuses the entire read path —
// campaign shapes, ad set roll-ups, pacing, period comparison, the reasoning
// engine, the AI pipeline — with no second implementation to keep in step.
// Two properties make it safe:
//
//   1. Upload account ids start with "up" and real Meta ad account ids are
//      digits only, so the two can never collide and a sync can never target
//      an uploaded batch (app/api/sync/meta/route.ts refuses one explicitly).
//   2. `data_source` marks every uploaded campaign, so provenance survives
//      into the UI and the AI narrative rather than reading as live data.

import { getSql } from "./db";
import type { NormalizedUpload } from "./adsReport";
import type { Capability, Level, Granularity, Tier, Mapping } from "./reportFields";

/** Upload accounts are "up" + hex; Meta ad account ids are digits only. */
export const UPLOAD_ACCOUNT_PREFIX = "up";

/**
 * The provenance marker carried on every uploaded campaign (Campaign.note).
 *
 * It is the one signal that survives the whole read path, so the reasoning
 * engine and the AI narrative can state where the numbers came from. Uploaded
 * figures must never be described as a live API read.
 */
export const UPLOAD_NOTE = "Uploaded report";

export const isUploadedCampaign = (c: { note?: string | null } | null | undefined): boolean =>
  c?.note === UPLOAD_NOTE;

export function isUploadAccount(id: string | null | undefined): boolean {
  return /^up[0-9a-f]{12}$/.test(String(id ?? ""));
}

export function newUploadAccountId(): string {
  let hex = "";
  for (let i = 0; i < 12; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return `${UPLOAD_ACCOUNT_PREFIX}${hex}`;
}

/** One file that fed a batch. A batch built from monthly exports has several. */
export interface UploadSource {
  filename: string;
  sheet: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  rows: number;
  uploadedAt: string;
}

export interface UploadBatch {
  id: string;
  label: string;
  filename: string;
  sheet: string | null;
  currency: string;
  timezone: string;
  level: Level;
  granularity: Granularity;
  tier: Tier;
  dateStart: string | null;
  dateEnd: string | null;
  distinctDays: number;
  rowsParsed: number;
  campaigns: number;
  adsets: number;
  ads: number;
  dayRows: number;
  capabilities: Capability[];
  warnings: string[];
  mapping: Mapping;
  unmapped: string[];
  /** Every file merged into this batch, oldest first. */
  sources: UploadSource[];
  uploadedAt: string;
}

/* ═══════════════════════ schema ═══════════════════════ */

let ready: Promise<void> | null = null;

/**
 * Create everything an upload needs, idempotently.
 *
 * The meta_* tables are created here too. A deployment that has never
 * connected a Meta account has never run db/meta-sync.sql, and uploads must
 * work on a database that only ever holds uploaded reports.
 */
export function ensureUploadSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const sql = getSql();

      await sql`CREATE TABLE IF NOT EXISTS meta_campaigns (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'ACTIVE',
        objective TEXT DEFAULT '—', daily_budget NUMERIC DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT now())`;
      await sql`CREATE TABLE IF NOT EXISTS meta_daily_metrics (
        campaign_id TEXT NOT NULL REFERENCES meta_campaigns(id) ON DELETE CASCADE,
        date DATE NOT NULL, spend NUMERIC DEFAULT 0, impressions BIGINT DEFAULT 0,
        clicks BIGINT DEFAULT 0, conversions BIGINT DEFAULT 0, ctr NUMERIC DEFAULT 0,
        cpc NUMERIC DEFAULT 0, roas NUMERIC DEFAULT 0,
        PRIMARY KEY (campaign_id, date))`;
      await sql`CREATE TABLE IF NOT EXISTS sync_log (
        source TEXT PRIMARY KEY, last_synced TIMESTAMPTZ NOT NULL, detail TEXT)`;
      await sql`CREATE TABLE IF NOT EXISTS meta_adsets (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES meta_campaigns(id) ON DELETE CASCADE,
        name TEXT NOT NULL, status TEXT DEFAULT 'ACTIVE',
        updated_at TIMESTAMPTZ DEFAULT now())`;
      await sql`CREATE TABLE IF NOT EXISTS meta_adset_daily (
        adset_id TEXT NOT NULL REFERENCES meta_adsets(id) ON DELETE CASCADE,
        date DATE NOT NULL, spend NUMERIC DEFAULT 0, impressions BIGINT DEFAULT 0,
        clicks BIGINT DEFAULT 0, conversions BIGINT DEFAULT 0, ctr NUMERIC DEFAULT 0,
        cpc NUMERIC DEFAULT 0, roas NUMERIC DEFAULT 0, frequency NUMERIC DEFAULT 0,
        reach BIGINT DEFAULT 0, PRIMARY KEY (adset_id, date))`;
      await sql`CREATE TABLE IF NOT EXISTS meta_ads (
        id TEXT PRIMARY KEY,
        adset_id TEXT NOT NULL REFERENCES meta_adsets(id) ON DELETE CASCADE,
        name TEXT NOT NULL, format TEXT DEFAULT 'Image', status TEXT DEFAULT 'ACTIVE',
        updated_at TIMESTAMPTZ DEFAULT now())`;
      await sql`CREATE TABLE IF NOT EXISTS meta_ad_daily (
        ad_id TEXT NOT NULL REFERENCES meta_ads(id) ON DELETE CASCADE,
        date DATE NOT NULL, spend NUMERIC DEFAULT 0, impressions BIGINT DEFAULT 0,
        clicks BIGINT DEFAULT 0, conversions BIGINT DEFAULT 0, ctr NUMERIC DEFAULT 0,
        roas NUMERIC DEFAULT 0, frequency NUMERIC DEFAULT 0,
        PRIMARY KEY (ad_id, date))`;

      // Columns lib/meta.ts's readers expect. ensureMetaSchema() adds the same
      // set for Graph-synced installs; repeating them keeps an upload-only
      // database complete without depending on a live sync ever having run.
      await sql`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS ad_account_id TEXT`;
      await sql`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS effective_status TEXT`;
      await sql`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS lifetime_budget NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS start_time TIMESTAMPTZ`;
      await sql`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS stop_time TIMESTAMPTZ`;
      await sql`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS data_source TEXT DEFAULT 'graph'`;
      // Flight-to-date pacing from an uploaded pacing tracker. Null on every
      // Graph-synced row, which keeps being paced from its daily metrics.
      await sql`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS flight_budget NUMERIC`;
      await sql`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS flight_days_total NUMERIC`;
      await sql`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS flight_days_elapsed NUMERIC`;
      await sql`ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS flight_status_reported TEXT`;
      await sql`ALTER TABLE meta_daily_metrics ADD COLUMN IF NOT EXISTS cpm NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_daily_metrics ADD COLUMN IF NOT EXISTS reach BIGINT DEFAULT 0`;
      await sql`ALTER TABLE meta_daily_metrics ADD COLUMN IF NOT EXISTS frequency NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_daily_metrics ADD COLUMN IF NOT EXISTS conv_value NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_daily_metrics ADD COLUMN IF NOT EXISTS actions JSONB DEFAULT '{}'::jsonb`;
      await sql`ALTER TABLE meta_adsets ADD COLUMN IF NOT EXISTS effective_status TEXT`;
      await sql`ALTER TABLE meta_adsets ADD COLUMN IF NOT EXISTS daily_budget NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_adsets ADD COLUMN IF NOT EXISTS lifetime_budget NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_adsets ADD COLUMN IF NOT EXISTS start_time TIMESTAMPTZ`;
      await sql`ALTER TABLE meta_adsets ADD COLUMN IF NOT EXISTS stop_time TIMESTAMPTZ`;
      await sql`ALTER TABLE meta_adsets ADD COLUMN IF NOT EXISTS optimization_goal TEXT`;
      await sql`ALTER TABLE meta_adsets ADD COLUMN IF NOT EXISTS destination_type TEXT`;
      await sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS actions JSONB DEFAULT '{}'::jsonb`;
      await sql`ALTER TABLE meta_ads ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`;
      await sql`ALTER TABLE meta_ads ADD COLUMN IF NOT EXISTS title TEXT`;
      await sql`ALTER TABLE meta_ads ADD COLUMN IF NOT EXISTS body TEXT`;
      await sql`ALTER TABLE meta_ads ADD COLUMN IF NOT EXISTS permalink TEXT`;
      await sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS actions JSONB DEFAULT '{}'::jsonb`;
      await sql`CREATE INDEX IF NOT EXISTS idx_meta_campaigns_account ON meta_campaigns(ad_account_id)`;

      await sql`CREATE TABLE IF NOT EXISTS upload_batches (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        filename TEXT NOT NULL,
        sheet TEXT,
        currency TEXT NOT NULL DEFAULT 'USD',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        level TEXT NOT NULL DEFAULT 'campaign',
        granularity TEXT NOT NULL DEFAULT 'snapshot',
        tier TEXT NOT NULL DEFAULT 'snapshot',
        date_start DATE, date_end DATE,
        distinct_days INT DEFAULT 0,
        rows_parsed INT DEFAULT 0,
        campaigns INT DEFAULT 0, adsets INT DEFAULT 0, ads INT DEFAULT 0, day_rows INT DEFAULT 0,
        capabilities JSONB DEFAULT '[]'::jsonb,
        warnings JSONB DEFAULT '[]'::jsonb,
        mapping JSONB DEFAULT '{}'::jsonb,
        unmapped JSONB DEFAULT '[]'::jsonb,
        sources JSONB DEFAULT '[]'::jsonb,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      // A batch can be fed by several monthly exports; `sources` keeps the
      // provenance of each so a report can name the files behind it.
      await sql`ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS sources JSONB DEFAULT '[]'::jsonb`;
    })().catch((e) => {
      ready = null; // retry next request rather than caching the failure
      throw e;
    });
  }
  return ready;
}

/* ═══════════════════════ writing ═══════════════════════ */

// Rows are written with UNNEST rather than one statement each: an ad-set-level
// month is comfortably 10,000 day rows, and that many round trips over Neon's
// HTTP driver would time out long before it finished.
const CHUNK = 1000;

function chunks<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const ts = (d: string | null) => (d ? `${d}T00:00:00Z` : null);

export type CommitMode = "replace" | "append";

export interface CommitInput {
  account: string;
  /**
   * "replace" rewrites the batch from this file alone (the default).
   * "append" merges this file into an existing batch, which is what makes a
   * month-over-month report possible: one batch accumulates several monthly
   * exports instead of each upload discarding the last.
   */
  mode?: CommitMode;
  label: string;
  filename: string;
  sheet: string | null;
  timezone: string;
  level: Level;
  granularity: Granularity;
  tier: Tier;
  distinctDays: number;
  rowsParsed: number;
  capabilities: Capability[];
  warnings: string[];
  mapping: Mapping;
  unmapped: string[];
  data: NormalizedUpload;
}

/**
 * The batch as the database actually holds it.
 *
 * After an append, the newest file's own counts describe only part of the
 * batch. Reading them back means the recorded totals cannot drift from the
 * rows, whichever mode was used.
 */
async function recomputeStats(account: string): Promise<{
  campaigns: number; adsets: number; ads: number; dayRows: number;
  dateStart: string | null; dateEnd: string | null; distinctDays: number;
}> {
  const sql = getSql();
  const rows = (await sql`
    SELECT
      (SELECT count(*)::int FROM meta_campaigns WHERE ad_account_id = ${account}) AS campaigns,
      (SELECT count(*)::int FROM meta_adsets s
         JOIN meta_campaigns c ON c.id = s.campaign_id WHERE c.ad_account_id = ${account}) AS adsets,
      (SELECT count(*)::int FROM meta_ads a
         JOIN meta_adsets s ON s.id = a.adset_id
         JOIN meta_campaigns c ON c.id = s.campaign_id WHERE c.ad_account_id = ${account}) AS ads,
      (SELECT count(*)::int FROM meta_daily_metrics m
         JOIN meta_campaigns c ON c.id = m.campaign_id WHERE c.ad_account_id = ${account}) AS day_rows,
      (SELECT to_char(min(m.date), 'YYYY-MM-DD') FROM meta_daily_metrics m
         JOIN meta_campaigns c ON c.id = m.campaign_id WHERE c.ad_account_id = ${account}) AS date_start,
      (SELECT to_char(max(m.date), 'YYYY-MM-DD') FROM meta_daily_metrics m
         JOIN meta_campaigns c ON c.id = m.campaign_id WHERE c.ad_account_id = ${account}) AS date_end,
      (SELECT count(DISTINCT m.date)::int FROM meta_daily_metrics m
         JOIN meta_campaigns c ON c.id = m.campaign_id WHERE c.ad_account_id = ${account}) AS distinct_days
  `) as unknown as Record<string, unknown>[];
  const r = rows[0] ?? {};
  return {
    campaigns: Number(r.campaigns ?? 0),
    adsets: Number(r.adsets ?? 0),
    ads: Number(r.ads ?? 0),
    dayRows: Number(r.day_rows ?? 0),
    dateStart: r.date_start ? String(r.date_start) : null,
    dateEnd: r.date_end ? String(r.date_end) : null,
    distinctDays: Number(r.distinct_days ?? 0),
  };
}

/**
 * Write one parsed report into the meta_* tables under its own account id.
 *
 * Re-committing the same account replaces its contents: entity ids are derived
 * from the account plus the natural key, so a corrected re-export updates the
 * rows it shares and the delete below removes anything that has gone away.
 */
export async function commitUpload(input: CommitInput): Promise<UploadBatch> {
  await ensureUploadSchema();
  const sql = getSql();
  const { account, data } = input;

  const mode: CommitMode = input.mode ?? "replace";

  // Replacing drops everything first: leftovers from a previous version of the
  // same batch would silently widen every total. Cascades clear adsets, ads and
  // day rows. Appending keeps them — entity ids are deterministic per batch, so
  // a campaign present in both files updates in place and only its new dates
  // are added.
  if (mode === "replace") {
    await sql`DELETE FROM meta_campaigns WHERE ad_account_id = ${account}`;
  }

  for (const part of chunks(data.campaigns)) {
    await sql`
      INSERT INTO meta_campaigns
        (id, name, status, effective_status, objective, daily_budget, lifetime_budget,
         start_time, stop_time, ad_account_id, data_source, updated_at,
         flight_budget, flight_days_total, flight_days_elapsed, flight_status_reported)
      SELECT * FROM UNNEST(
        ${part.map((c) => c.id)}::text[],
        ${part.map((c) => c.name)}::text[],
        ${part.map((c) => c.status)}::text[],
        ${part.map((c) => c.status)}::text[],
        ${part.map((c) => c.objective)}::text[],
        ${part.map((c) => c.dailyBudget)}::numeric[],
        ${part.map((c) => c.lifetimeBudget)}::numeric[],
        ${part.map((c) => ts(c.startTime))}::timestamptz[],
        ${part.map((c) => ts(c.stopTime))}::timestamptz[],
        ${part.map(() => account)}::text[],
        ${part.map(() => "upload")}::text[],
        ${part.map(() => new Date().toISOString())}::timestamptz[],
        ${part.map((c) => c.flight?.budget ?? null)}::numeric[],
        ${part.map((c) => c.flight?.daysTotal ?? null)}::numeric[],
        ${part.map((c) => c.flight?.daysElapsed ?? null)}::numeric[],
        ${part.map((c) => c.flight?.reportedStatus ?? null)}::text[])
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, status = EXCLUDED.status,
        effective_status = EXCLUDED.effective_status, objective = EXCLUDED.objective,
        daily_budget = EXCLUDED.daily_budget, lifetime_budget = EXCLUDED.lifetime_budget,
        start_time = EXCLUDED.start_time, stop_time = EXCLUDED.stop_time,
        updated_at = EXCLUDED.updated_at,
        flight_budget = EXCLUDED.flight_budget,
        flight_days_total = EXCLUDED.flight_days_total,
        flight_days_elapsed = EXCLUDED.flight_days_elapsed,
        flight_status_reported = EXCLUDED.flight_status_reported`;
  }

  const campaignDays = data.campaigns.flatMap((c) => c.days.map((d) => ({ parent: c.id, d })));
  for (const part of chunks(campaignDays)) {
    await sql`
      INSERT INTO meta_daily_metrics
        (campaign_id, date, spend, impressions, clicks, conversions, ctr, cpc, roas,
         cpm, reach, frequency, conv_value, actions)
      SELECT * FROM UNNEST(
        ${part.map((r) => r.parent)}::text[],
        ${part.map((r) => r.d.date)}::date[],
        ${part.map((r) => r.d.spend)}::numeric[],
        ${part.map((r) => Math.round(r.d.impressions))}::bigint[],
        ${part.map((r) => Math.round(r.d.clicks))}::bigint[],
        ${part.map((r) => Math.round(r.d.conversions))}::bigint[],
        ${part.map((r) => r.d.ctr)}::numeric[],
        ${part.map((r) => r.d.cpc)}::numeric[],
        ${part.map((r) => r.d.roas)}::numeric[],
        ${part.map((r) => r.d.cpm)}::numeric[],
        ${part.map((r) => Math.round(r.d.reach))}::bigint[],
        ${part.map((r) => r.d.frequency)}::numeric[],
        ${part.map((r) => r.d.convValue)}::numeric[],
        ${part.map((r) => JSON.stringify(r.d.actions))}::jsonb[])
      ON CONFLICT (campaign_id, date) DO UPDATE SET
        spend = EXCLUDED.spend, impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks, conversions = EXCLUDED.conversions,
        ctr = EXCLUDED.ctr, cpc = EXCLUDED.cpc, roas = EXCLUDED.roas,
        cpm = EXCLUDED.cpm, reach = EXCLUDED.reach, frequency = EXCLUDED.frequency,
        conv_value = EXCLUDED.conv_value, actions = EXCLUDED.actions`;
  }

  const allSets = data.campaigns.flatMap((c) => c.adsets.map((s) => ({ campaignId: c.id, s })));
  for (const part of chunks(allSets)) {
    await sql`
      INSERT INTO meta_adsets
        (id, campaign_id, name, status, effective_status, daily_budget, lifetime_budget,
         start_time, stop_time, optimization_goal, destination_type, updated_at)
      SELECT * FROM UNNEST(
        ${part.map((r) => r.s.id)}::text[],
        ${part.map((r) => r.campaignId)}::text[],
        ${part.map((r) => r.s.name)}::text[],
        ${part.map((r) => r.s.status)}::text[],
        ${part.map((r) => r.s.status)}::text[],
        ${part.map((r) => r.s.dailyBudget)}::numeric[],
        ${part.map((r) => r.s.lifetimeBudget)}::numeric[],
        ${part.map((r) => ts(r.s.startTime))}::timestamptz[],
        ${part.map((r) => ts(r.s.stopTime))}::timestamptz[],
        ${part.map((r) => r.s.optimizationGoal)}::text[],
        ${part.map((r) => r.s.destinationType)}::text[],
        ${part.map(() => new Date().toISOString())}::timestamptz[])
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, status = EXCLUDED.status,
        effective_status = EXCLUDED.effective_status,
        daily_budget = EXCLUDED.daily_budget, lifetime_budget = EXCLUDED.lifetime_budget,
        start_time = EXCLUDED.start_time, stop_time = EXCLUDED.stop_time,
        updated_at = EXCLUDED.updated_at`;
  }

  const setDays = data.campaigns.flatMap((c) => c.adsets.flatMap((s) => s.days.map((d) => ({ parent: s.id, d }))));
  for (const part of chunks(setDays)) {
    await sql`
      INSERT INTO meta_adset_daily
        (adset_id, date, spend, impressions, clicks, conversions, ctr, cpc, roas,
         frequency, reach, actions)
      SELECT * FROM UNNEST(
        ${part.map((r) => r.parent)}::text[],
        ${part.map((r) => r.d.date)}::date[],
        ${part.map((r) => r.d.spend)}::numeric[],
        ${part.map((r) => Math.round(r.d.impressions))}::bigint[],
        ${part.map((r) => Math.round(r.d.clicks))}::bigint[],
        ${part.map((r) => Math.round(r.d.conversions))}::bigint[],
        ${part.map((r) => r.d.ctr)}::numeric[],
        ${part.map((r) => r.d.cpc)}::numeric[],
        ${part.map((r) => r.d.roas)}::numeric[],
        ${part.map((r) => r.d.frequency)}::numeric[],
        ${part.map((r) => Math.round(r.d.reach))}::bigint[],
        ${part.map((r) => JSON.stringify(r.d.actions))}::jsonb[])
      ON CONFLICT (adset_id, date) DO UPDATE SET
        spend = EXCLUDED.spend, impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks, conversions = EXCLUDED.conversions,
        ctr = EXCLUDED.ctr, cpc = EXCLUDED.cpc, roas = EXCLUDED.roas,
        frequency = EXCLUDED.frequency, reach = EXCLUDED.reach, actions = EXCLUDED.actions`;
  }

  const allAds = data.campaigns.flatMap((c) => c.adsets.flatMap((s) => s.ads.map((a) => ({ adsetId: s.id, a }))));
  for (const part of chunks(allAds)) {
    await sql`
      INSERT INTO meta_ads (id, adset_id, name, format, status, updated_at)
      SELECT * FROM UNNEST(
        ${part.map((r) => r.a.id)}::text[],
        ${part.map((r) => r.adsetId)}::text[],
        ${part.map((r) => r.a.name)}::text[],
        ${part.map((r) => r.a.format)}::text[],
        ${part.map(() => "ACTIVE")}::text[],
        ${part.map(() => new Date().toISOString())}::timestamptz[])
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, format = EXCLUDED.format, updated_at = EXCLUDED.updated_at`;
  }

  const adDays = data.campaigns.flatMap((c) =>
    c.adsets.flatMap((s) => s.ads.flatMap((a) => a.days.map((d) => ({ parent: a.id, d })))));
  for (const part of chunks(adDays)) {
    await sql`
      INSERT INTO meta_ad_daily
        (ad_id, date, spend, impressions, clicks, conversions, ctr, roas, frequency, actions)
      SELECT * FROM UNNEST(
        ${part.map((r) => r.parent)}::text[],
        ${part.map((r) => r.d.date)}::date[],
        ${part.map((r) => r.d.spend)}::numeric[],
        ${part.map((r) => Math.round(r.d.impressions))}::bigint[],
        ${part.map((r) => Math.round(r.d.clicks))}::bigint[],
        ${part.map((r) => Math.round(r.d.conversions))}::bigint[],
        ${part.map((r) => r.d.ctr)}::numeric[],
        ${part.map((r) => r.d.roas)}::numeric[],
        ${part.map((r) => r.d.frequency)}::numeric[],
        ${part.map((r) => JSON.stringify(r.d.actions))}::jsonb[])
      ON CONFLICT (ad_id, date) DO UPDATE SET
        spend = EXCLUDED.spend, impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks, conversions = EXCLUDED.conversions,
        ctr = EXCLUDED.ctr, roas = EXCLUDED.roas,
        frequency = EXCLUDED.frequency, actions = EXCLUDED.actions`;
  }

  const previous = mode === "append" ? await getBatch(account) : null;

  const source: UploadSource = {
    filename: input.filename,
    sheet: input.sheet,
    dateStart: data.dateStart,
    dateEnd: data.dateEnd,
    rows: input.rowsParsed,
    uploadedAt: new Date().toISOString(),
  };
  const sources = [...(previous?.sources ?? []), source];

  // A capability holds for the batch only if EVERY file supports it. If August
  // carried frequency and September did not, the batch cannot claim frequency —
  // overstating it is exactly the failure mode this codebase avoids elsewhere.
  const capabilities = previous
    ? input.capabilities.map((c) => {
        const before = previous.capabilities.find((p) => p.key === c.key);
        if (!before || before.available === c.available) return c;
        return c.available
          ? { ...c, available: false, reason: `Not in every uploaded file — ${before.reason}` }
          : c;
      })
    : input.capabilities;

  const warnings = previous
    ? Array.from(new Set([...previous.warnings, ...input.warnings]))
    : input.warnings;

  // Counts come back from the database rather than from this file, so an
  // append reports the batch as it now stands instead of only its newest part.
  const stats = await recomputeStats(account);

  await sql`
    INSERT INTO upload_batches
      (id, label, filename, sheet, currency, timezone, level, granularity, tier,
       date_start, date_end, distinct_days, rows_parsed, campaigns, adsets, ads, day_rows,
       capabilities, warnings, mapping, unmapped, sources, uploaded_at)
    VALUES (${account}, ${input.label}, ${input.filename}, ${input.sheet},
            ${data.currency}, ${input.timezone}, ${input.level}, ${input.granularity}, ${input.tier},
            ${stats.dateStart}, ${stats.dateEnd}, ${stats.distinctDays},
            ${(previous?.rowsParsed ?? 0) + input.rowsParsed},
            ${stats.campaigns}, ${stats.adsets}, ${stats.ads}, ${stats.dayRows},
            ${JSON.stringify(capabilities)}::jsonb, ${JSON.stringify(warnings)}::jsonb,
            ${JSON.stringify(input.mapping)}::jsonb, ${JSON.stringify(input.unmapped)}::jsonb,
            ${JSON.stringify(sources)}::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      label = EXCLUDED.label, filename = EXCLUDED.filename, sheet = EXCLUDED.sheet,
      currency = EXCLUDED.currency, timezone = EXCLUDED.timezone, level = EXCLUDED.level,
      granularity = EXCLUDED.granularity, tier = EXCLUDED.tier,
      date_start = EXCLUDED.date_start, date_end = EXCLUDED.date_end,
      distinct_days = EXCLUDED.distinct_days, rows_parsed = EXCLUDED.rows_parsed,
      campaigns = EXCLUDED.campaigns, adsets = EXCLUDED.adsets, ads = EXCLUDED.ads,
      day_rows = EXCLUDED.day_rows, capabilities = EXCLUDED.capabilities,
      warnings = EXCLUDED.warnings, mapping = EXCLUDED.mapping, unmapped = EXCLUDED.unmapped,
      sources = EXCLUDED.sources, uploaded_at = now()`;

  const batch = await getBatch(account);
  if (!batch) throw new Error("Upload was written but could not be read back.");
  return batch;
}

/* ═══════════════════════ reading ═══════════════════════ */

const asArray = <T,>(v: unknown, fallback: T[]): T[] => {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : fallback; } catch { return fallback; } }
  return fallback;
};
const asObject = <T,>(v: unknown, fallback: T): T => {
  if (v && typeof v === "object") return v as T;
  if (typeof v === "string") { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return fallback;
};
const isoDate = (v: unknown): string | null => {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : new Date(s).toISOString().slice(0, 10);
};

function toBatch(r: Record<string, unknown>): UploadBatch {
  return {
    id: String(r.id),
    label: String(r.label ?? ""),
    filename: String(r.filename ?? ""),
    sheet: r.sheet ? String(r.sheet) : null,
    currency: String(r.currency ?? "USD"),
    timezone: String(r.timezone ?? "UTC"),
    level: String(r.level ?? "campaign") as Level,
    granularity: String(r.granularity ?? "snapshot") as Granularity,
    tier: String(r.tier ?? "snapshot") as Tier,
    dateStart: isoDate(r.date_start),
    dateEnd: isoDate(r.date_end),
    distinctDays: Number(r.distinct_days ?? 0),
    rowsParsed: Number(r.rows_parsed ?? 0),
    campaigns: Number(r.campaigns ?? 0),
    adsets: Number(r.adsets ?? 0),
    ads: Number(r.ads ?? 0),
    dayRows: Number(r.day_rows ?? 0),
    capabilities: asArray<Capability>(r.capabilities, []),
    warnings: asArray<string>(r.warnings, []),
    mapping: asObject<Mapping>(r.mapping, {}),
    unmapped: asArray<string>(r.unmapped, []),
    sources: asArray<UploadSource>(r.sources, []),
    uploadedAt: r.uploaded_at ? new Date(String(r.uploaded_at)).toISOString() : new Date().toISOString(),
  };
}

/** Every uploaded batch, newest first. Returns [] when the table is absent. */
export async function listBatches(): Promise<UploadBatch[]> {
  try {
    const rows = (await getSql()`
      SELECT * FROM upload_batches ORDER BY uploaded_at DESC`) as unknown as Record<string, unknown>[];
    return rows.map(toBatch);
  } catch {
    // No database, or no upload_batches yet — no uploads is a valid state.
    return [];
  }
}

export async function getBatch(id: string): Promise<UploadBatch | null> {
  if (!isUploadAccount(id)) return null;
  try {
    const rows = (await getSql()`
      SELECT * FROM upload_batches WHERE id = ${id} LIMIT 1`) as unknown as Record<string, unknown>[];
    return rows.length ? toBatch(rows[0]) : null;
  } catch {
    return null;
  }
}

/** Delete a batch and every row it wrote. */
export async function deleteBatch(id: string): Promise<boolean> {
  if (!isUploadAccount(id)) return false;
  const sql = getSql();
  await sql`DELETE FROM meta_campaigns WHERE ad_account_id = ${id}`;
  const rows = (await sql`DELETE FROM upload_batches WHERE id = ${id} RETURNING id`) as unknown as unknown[];
  return rows.length > 0;
}
