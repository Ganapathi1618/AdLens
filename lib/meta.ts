// ── Meta Graph API plumbing ─────────────────────────────────────────
// Two halves: (1) fetchers used by app/api/sync/meta to PULL from Meta,
// (2) Neon readers that map synced rows into the app's own Campaign /
// DayPoint shapes for MetaDataSource. Token-optional: with no env vars
// set, nothing in this file ever executes.

import { getSql } from "./db";
import type { Campaign, AdSet, AdItem } from "./data";
import type { DayPoint } from "./datasource";
import { resultLadder } from "./meta-labels";
import { computePacing, daysBetween, daysElapsedSince, type Pacing } from "./pacing";
import { mapMetaStatus } from "./status";
import { UPLOAD_NOTE } from "./uploads";
export { resultLadder }; // type-only import — no runtime cycle

const graphBase = () => `https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}`;

export function metaConfigured(): boolean {
  return Boolean(currentToken() && currentAccountId());
}

/** Token for the account being read. Set per request from an OAuth connection
 *  (see setActiveToken); falls back to the single env var so an existing
 *  System-User setup keeps working unchanged. */
let activeTokenOverride: string | null = null;

export function setActiveToken(token: string | null | undefined) {
  activeTokenOverride = token || null;
}

export function currentToken(): string {
  return String(activeTokenOverride ?? process.env.META_ACCESS_TOKEN ?? "");
}

/** Resolve credentials for an ad account connected via OAuth, falling back to
 *  the env-var account. Call before any live read so the Graph layer talks to
 *  the right account with the right token. */
export async function useConnectedAccount(accountId?: string | null): Promise<boolean> {
  const { getConnectionStore } = await import("./connections");
  try {
    const store = getConnectionStore();
    const id = accountId ? String(accountId).replace(/^act_/, "") : null;
    if (id) {
      const token = await store.tokenForAccount(id);
      if (token) { setActiveToken(token); setActiveAccount(id); return true; }
      return false;
    }
    // No explicit choice: use the first connected account, if any.
    const accounts = await store.listAccounts();
    if (accounts.length > 0) {
      const token = await store.tokenForAccount(accounts[0].id);
      if (token) { setActiveToken(token); setActiveAccount(accounts[0].id); return true; }
    }
  } catch {
    // Store unavailable — fall through to env credentials.
  }
  return false;
}

export const LIVE_PREFIX = "meta_"; // live ids can never collide with seeded ids

/* ── Schema drift guard ─────────────────────────────────────────────
   db/meta-sync.sql created the ORIGINAL columns; the code has since grown to
   write more (ad_account_id, actions, cpm/reach/frequency/conv_value, creative
   fields). A database made from the old file therefore fails inserts, and —
   worse — makes the account-scoped reads throw, which silently degrades to an
   UNSCOPED read that mixes two ad accounts' campaigns together.
   Adding the columns on first use closes both holes. All statements are
   idempotent, so this is safe to run on every cold start. */
/**
 * Make sure the meta_* tables exist at all.
 *
 * ensureMetaSchema below only ALTERs — it assumes db/meta-sync.sql was run.
 * A deployment that only ever uploads reports has never run it, so the tables
 * are created on first read instead. Failures are swallowed: a Graph-synced
 * install already has its tables and must not be blocked by this.
 */
export async function ensureUploadTables(): Promise<void> {
  try {
    const { ensureUploadSchema } = await import("./uploads");
    await ensureUploadSchema();
  } catch {
    /* no database, or no permission to create — the reads report their own errors */
  }
}

let metaSchemaReady: Promise<void> | null = null;

export function ensureMetaSchema(): Promise<void> {
  if (!metaSchemaReady) {
    metaSchemaReady = (async () => {
      const sql = getSql();
      await sql`ALTER TABLE meta_campaigns   ADD COLUMN IF NOT EXISTS ad_account_id     TEXT`;
      // Status + budget/schedule: required for correct status display and for
      // time-aware pacing at campaign and ad set level.
      await sql`ALTER TABLE meta_campaigns   ADD COLUMN IF NOT EXISTS effective_status  TEXT`;
      await sql`ALTER TABLE meta_campaigns   ADD COLUMN IF NOT EXISTS lifetime_budget   NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_campaigns   ADD COLUMN IF NOT EXISTS start_time        TIMESTAMPTZ`;
      await sql`ALTER TABLE meta_campaigns   ADD COLUMN IF NOT EXISTS stop_time         TIMESTAMPTZ`;
      await sql`ALTER TABLE meta_adsets      ADD COLUMN IF NOT EXISTS effective_status  TEXT`;
      await sql`ALTER TABLE meta_adsets      ADD COLUMN IF NOT EXISTS lifetime_budget   NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_adsets      ADD COLUMN IF NOT EXISTS start_time        TIMESTAMPTZ`;
      await sql`ALTER TABLE meta_adsets      ADD COLUMN IF NOT EXISTS stop_time         TIMESTAMPTZ`;
      await sql`ALTER TABLE meta_daily_metrics ADD COLUMN IF NOT EXISTS cpm            NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_daily_metrics ADD COLUMN IF NOT EXISTS reach          BIGINT  DEFAULT 0`;
      await sql`ALTER TABLE meta_daily_metrics ADD COLUMN IF NOT EXISTS frequency      NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_daily_metrics ADD COLUMN IF NOT EXISTS conv_value     NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_daily_metrics ADD COLUMN IF NOT EXISTS actions        JSONB   DEFAULT '{}'::jsonb`;
      await sql`ALTER TABLE meta_adsets      ADD COLUMN IF NOT EXISTS daily_budget      NUMERIC DEFAULT 0`;
      await sql`ALTER TABLE meta_adsets      ADD COLUMN IF NOT EXISTS optimization_goal TEXT`;
      await sql`ALTER TABLE meta_adsets      ADD COLUMN IF NOT EXISTS destination_type  TEXT`;
      await sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS actions           JSONB DEFAULT '{}'::jsonb`;
      await sql`ALTER TABLE meta_ads         ADD COLUMN IF NOT EXISTS thumbnail_url     TEXT`;
      await sql`ALTER TABLE meta_ads         ADD COLUMN IF NOT EXISTS title             TEXT`;
      await sql`ALTER TABLE meta_ads         ADD COLUMN IF NOT EXISTS body              TEXT`;
      await sql`ALTER TABLE meta_ads         ADD COLUMN IF NOT EXISTS permalink         TEXT`;
      await sql`ALTER TABLE meta_ad_daily    ADD COLUMN IF NOT EXISTS actions           JSONB DEFAULT '{}'::jsonb`;
      await sql`CREATE INDEX IF NOT EXISTS idx_meta_campaigns_account ON meta_campaigns(ad_account_id)`;
    })().catch((e) => {
      metaSchemaReady = null; // retry next request rather than caching failure
      throw e;
    });
  }
  return metaSchemaReady;
}

/** The ad account currently configured. Every live read is scoped to it, so
 *  connecting a different account cannot surface the previous account's rows
 *  and two accounts' data can never be mixed. */
let activeAccountOverride: string | null = null;

/** Select the ad account for the current request. Falls back to the env var
 *  only when nothing was chosen, so a single configured account still works. */
export function setActiveAccount(id: string | null | undefined) {
  activeAccountOverride = id ? String(id).replace(/^act_/, "") : null;
}

export function currentAccountId(): string {
  return String(activeAccountOverride ?? process.env.META_AD_ACCOUNT_ID ?? "");
}

/**
 * Point the active account at whichever account owns this campaign.
 *
 * Every read below is scoped by ad account, but the per-campaign routes
 * (/api/db/campaign-detail, /api/db/periods) are called with only a campaign
 * id. Without this they fall back to META_AD_ACCOUNT_ID and return nothing for
 * any campaign that account does not own — which is every campaign on a
 * deployment that has no env credential at all, uploads included.
 *
 * A campaign id determines its account uniquely, so resolving from the row can
 * only correct the scope, never widen it.
 */
export async function ensureAccountForCampaign(metaId: string): Promise<void> {
  if (!metaId) return;
  try {
    const rows = (await getSql()`
      SELECT ad_account_id FROM meta_campaigns WHERE id = ${metaId} LIMIT 1`) as unknown as Record<string, unknown>[];
    const owner = rows.length ? String(rows[0].ad_account_id ?? "") : "";
    if (owner && owner !== currentAccountId()) setActiveAccount(owner);
  } catch {
    // Column not migrated yet, or no database — leave the scope as it was.
  }
}

/* ---------------- small helpers ---------------- */

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

type ActionValue = { action_type: string; value: string };

/** Every action type Meta reported, as { action_type: value }. Stored whole so
 *  any metric can be surfaced without re-syncing, and so a campaign with mixed
 *  optimisation goals can report each ad set on its own terms. */
export function actionsMap(actions?: ActionValue[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(actions)) return out;
  for (const a of actions) {
    const k = String(a?.action_type ?? "");
    if (k) out[k] = num(a.value);
  }
  return out;
}


// Meta hides results inside the `actions` array. Which action counts as a
// "result" depends on the campaign objective (see resultLadder).
function pickConversions(actions?: ActionValue[], objective?: string, goal?: string, dest?: string): number {
  if (!Array.isArray(actions)) return 0;
  for (const key of resultLadder(objective, goal, dest).types) {
    const hit = actions.find((a) => a.action_type === key);
    if (hit) return num(hit.value);
  }
  return 0;
}

function pickRoas(roas?: ActionValue[]): number {
  if (!Array.isArray(roas) || roas.length === 0) return 0;
  const omni = roas.find((r) => r.action_type === "omni_purchase") ?? roas[0];
  return num(omni.value);
}

/* ── Error classification ───────────────────────────────────────────
   Graph API failures are not interchangeable: an expired token needs a human,
   a rate limit needs a wait, a permission gap needs scope changes. Callers
   and the UI need to tell them apart to fail safely and usefully. */

export type GraphFailureKind =
  | "auth"        // token expired, revoked or invalid — needs a new token
  | "permission"  // token lacks the scope, or no access to the asset
  | "rate_limit"  // throttled — retry after a wait
  | "not_found"   // asset deleted or id wrong
  | "transient"   // temporary platform issue — retry
  | "unknown";

export class GraphError extends Error {
  kind: GraphFailureKind;
  code?: number;
  subcode?: number;
  retryable: boolean;
  hint: string;
  constructor(kind: GraphFailureKind, message: string, code?: number, subcode?: number) {
    super(message);
    this.name = "GraphError";
    this.kind = kind;
    this.code = code;
    this.subcode = subcode;
    this.retryable = kind === "rate_limit" || kind === "transient";
    this.hint = HINTS[kind];
  }
}

const HINTS: Record<GraphFailureKind, string> = {
  auth: "The access token is expired, revoked or invalid. Generate a new System User token with ads_read and update META_ACCESS_TOKEN.",
  permission: "The token is valid but lacks access. Confirm ads_read is granted and the ad account is assigned to the System User.",
  rate_limit: "Meta is throttling requests. The sync backs off and retries; if it persists, sync a shorter window or wait.",
  not_found: "The requested object no longer exists or the id is wrong. A re-sync will drop stale references.",
  transient: "A temporary platform error. Retried automatically; safe to run the sync again.",
  unknown: "Unclassified Graph API error — see the message for detail.",
};

function classify(code: number | undefined, subcode: number | undefined, http: number): GraphFailureKind {
  if (code === 190 || code === 102 || subcode === 463 || subcode === 467) return "auth";
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code ?? 0) >= 80000) return "rate_limit";
  if (code === 200 || code === 10 || code === 3 || code === 273) return "permission";
  if (code === 803 || http === 404) return "not_found";
  if (code === 1 || code === 2 || http >= 500) return "transient";
  return "unknown";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Meta reports remaining quota in a usage header. When we're close to the
 *  limit, slow down before being throttled rather than after. */
function usagePressure(res: Response): number {
  for (const h of ["x-business-use-case-usage", "x-ad-account-usage", "x-app-usage"]) {
    const raw = res.headers.get(h);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
      let worst = 0;
      for (const e of entries as Record<string, number>[]) {
        for (const k of ["call_count", "total_cputime", "total_time", "acc_id_util_pct"]) {
          if (typeof e?.[k] === "number") worst = Math.max(worst, e[k]);
        }
      }
      if (worst) return worst;
    } catch { /* header shape varies — ignore */ }
  }
  return 0;
}

async function graphGet(url: string, attempt = 0): Promise<any> {
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));

  if (!res.ok || json?.error) {
    const err = json?.error ?? {};
    const kind = classify(err.code, err.error_subcode, res.status);
    const e = new GraphError(
      kind,
      err.message || `Graph API error (HTTP ${res.status})`,
      err.code,
      err.error_subcode
    );
    // Retry throttling and transient failures with exponential backoff.
    if (e.retryable && attempt < 3) {
      await sleep(1000 * Math.pow(2, attempt));
      return graphGet(url, attempt + 1);
    }
    throw e;
  }

  // Pre-emptive slowdown when close to the quota.
  const pressure = usagePressure(res);
  if (pressure >= 90) await sleep(3000);
  else if (pressure >= 75) await sleep(1000);

  return json;
}

// Truncation ledger. A page cap prevents runaway loops, but silently dropping
// rows on a large account is a correctness bug, so every truncation is recorded
// and reported by the sync.
let truncations: { path: string; pagesFetched: number; rowsFetched: number }[] = [];
export function resetTruncations() { truncations = []; }
export function getTruncations() { return truncations; }

async function graphGetAll(firstUrl: string, maxPages = 25): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = firstUrl;
  let page = 0;
  while (next && page < maxPages) {
    const json = await graphGet(next);
    out.push(...(json.data ?? []));
    next = json?.paging?.next ?? null;
    page++;
  }
  if (next) {
    // More pages existed than we fetched — the caller must not present this
    // result as complete.
    truncations.push({
      path: firstUrl.split("?")[0].replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, ""),
      pagesFetched: page,
      rowsFetched: out.length,
    });
  }
  return out;
}

/** Today's date in the AD ACCOUNT's timezone. Meta reports insights in the
 *  account timezone, so building a window from the server's UTC clock can be
 *  a day out and silently shift every date label. */
function todayInTz(tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "01";
  return new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00Z`);
}

// "OUTCOME_SALES" → "Sales"
function prettyObjective(o?: string): string {
  if (!o) return "—";
  const word = String(o).replace(/^OUTCOME_/, "").toLowerCase().replace(/_/g, " ");
  return word.charAt(0).toUpperCase() + word.slice(1);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-07-19" → "Jul 19" (matches the seeded DayPoint.day format, no Date-parsing pitfalls)
function prettyDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1] ?? "?"} ${Number(d)}`;
}

/* ---------------- Graph API fetchers (used by /api/sync/meta) ---------------- */

export type MetaCampaignShell = {
  id: string;
  name: string;
  status: string;
  /** What Meta is ACTUALLY doing with it — the value the UI must display. */
  effectiveStatus: string;
  objective: string;
  dailyBudget: number; // dollars (Meta reports minor units — cents — we divide by 100)
  lifetimeBudget: number;
  startTime: string | null;
  stopTime: string | null;
};

export async function fetchMetaCampaignList(): Promise<MetaCampaignShell[]> {
  const token = currentToken();
  const acct = currentAccountId();
  // effective_status is the truth the UI needs: `status` says what the campaign
  // is set to, effective_status says what Meta is actually doing with it
  // (CAMPAIGN_PAUSED, ARCHIVED, IN_PROCESS, WITH_ISSUES…). lifetime_budget and
  // the schedule are required for time-aware pacing.
  const url =
    `${graphBase()}/act_${acct}/campaigns` +
    `?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time` +
    `&limit=100&access_token=${encodeURIComponent(token)}`;
  const rows = await graphGetAll(url);
  return rows.map((r: any) => ({
    id: String(r.id),
    name: String(r.name ?? r.id),
    status: String(r.status ?? "ACTIVE"),
    effectiveStatus: String(r.effective_status ?? r.status ?? "ACTIVE"),
    objective: prettyObjective(r.objective),
    dailyBudget: num(r.daily_budget) / 100,
    lifetimeBudget: num(r.lifetime_budget) / 100,
    startTime: r.start_time ? String(r.start_time) : null,
    stopTime: r.stop_time ? String(r.stop_time) : null,
  }));
}

export type MetaInsightRow = {
  campaign_id: string;
  date: string; // YYYY-MM-DD
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number;
  roas: number;
  cpm: number;
  reach: number;
  frequency: number;
  convValue: number;
  /** Every action type Meta reported for this row. */
  actions: Record<string, number>;
};

// One row per campaign per day for the trailing `days` days.
// Default 3: Meta restates recent conversions for ~72h (attribution lag),
// so we always re-pull the trailing window instead of only "yesterday".
/** How a fetch window is expressed to the platform. `preset` defers to Meta's
 *  own definition; `since/until` is an explicit custom range. */
export type FetchWindow =
  | { preset: string }
  | { since: string; until: string };

function windowParam(w: FetchWindow): string {
  return "preset" in w
    ? `&date_preset=${encodeURIComponent(w.preset)}`
    : `&time_range=${encodeURIComponent(JSON.stringify({ since: w.since, until: w.until }))}`;
}

export async function fetchMetaInsights(
  window: FetchWindow,
  objectiveById: Record<string, string> = {}
): Promise<MetaInsightRow[]> {
  const token = currentToken();
  const acct = currentAccountId();

  const fields = "campaign_id,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,action_values,purchase_roas";
  const url =
    `${graphBase()}/act_${acct}/insights` +
    `?level=campaign&time_increment=1&fields=${fields}` +
    `${windowParam(window)}&limit=100&access_token=${encodeURIComponent(token)}`;

  const raw = await graphGetAll(url);
  return raw.map((r: any) => ({
    campaign_id: String(r.campaign_id),
    date: String(r.date_start),
    spend: num(r.spend),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    conversions: pickConversions(r.actions, objectiveById[String(r.campaign_id)]),
    ctr: num(r.ctr),
    cpc: num(r.cpc),
    roas: pickRoas(r.purchase_roas),
    cpm: num(r.cpm),
    reach: num(r.reach),
    frequency: num(r.frequency),
    // Actual reported purchase VALUE, not roas*spend — so an account with no
    // purchase tracking stays 0 and renders as N/A rather than a fake revenue.
    convValue: pickConversions(r.action_values as ActionValue[] | undefined),
    actions: actionsMap(r.actions),
  }));
}

/* ---------------- Neon readers: synced rows → the app's own types ---------------- */

type LiveRow = {
  id: string;
  name: string;
  status: string;
  /** Meta's effective_status — what the platform is actually doing. */
  effective_status?: string | null;
  objective: string;
  daily_budget: number;
  lifetime_budget?: number;
  start_time?: string | null;
  stop_time?: string | null;
  account_currency?: string;
  /** 'graph' for a synced campaign, 'upload' for one read from a file. Drives
   *  the provenance label — uploaded numbers must never read as live ones. */
  data_source?: string | null;
  metrics: (MetaInsightRow & { conv_value?: number })[]; // per-day, oldest → newest
};

function normalizeMetrics(v: unknown): MetaInsightRow[] {
  if (Array.isArray(v)) return v as MetaInsightRow[];
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Objective-aware health. Coarse only — the reasoning engine refines it.
 *
 * Rules:
 *  - Never judge a campaign on a metric its objective does not produce. A
 *    Traffic or Awareness campaign has no purchase revenue, so ROAS is not
 *    evidence of anything and must not drive the verdict.
 *  - Never judge on too little data. Thresholds are volume-based
 *    (impressions), not currency-based, because a money threshold is
 *    meaningless across accounts with different currencies.
 *  - Absence of conversions is not failure.
 */
function healthOf(a: {
  status: string;
  revenueTracked: boolean;
  roas: number;
  ctrTrend: number[];
  impressions: number;
}): Campaign["health"] {
  if (a.status !== "Active") return "paused";

  // Not enough delivery to draw any conclusion — say nothing rather than
  // inventing a verdict.
  if (a.impressions < 1000) return "good";

  if (a.revenueTracked) {
    // Revenue exists, so efficiency is measurable.
    if (a.roas > 0 && a.roas < 1) return "critical"; // below break-even
    if (a.roas > 0 && a.roas < 2) return "watch";
    return "good";
  }

  // No revenue signal: judge delivery quality instead — a sustained CTR
  // decline is the only campaign-level deterioration we can evidence.
  let falls = 0;
  for (let i = a.ctrTrend.length - 1; i > 0; i--) {
    if (a.ctrTrend[i] < a.ctrTrend[i - 1]) falls++;
    else break;
  }
  if (falls >= 4) return "critical";
  if (falls >= 2) return "watch";
  return "good";
}

function toCampaign(row: LiveRow): Campaign {
  const days = row.metrics;
  const spend = days.reduce((s, d) => s + d.spend, 0);
  const revenue = days.reduce((s, d) => s + d.roas * d.spend, 0);
  const clicks = days.reduce((s, d) => s + d.clicks, 0);
  const impressions = days.reduce((s, d) => s + d.impressions, 0);
  const conv = days.reduce((s, d) => s + d.conversions, 0);
  const roas = spend > 0 ? revenue / spend : 0;
  // Status comes from effective_status when Meta reported it — `status` alone
  // says what the user set, not what the platform is doing.
  const status = mapMetaStatus(row.effective_status, row.status);

  // Pacing: actual spend vs the spend the budget implies for the elapsed time.
  // Previously this was last-night's spend ÷ daily budget, which ignored time
  // entirely and read 0% whenever the budget lived at ad set level.
  const deliveredDays = days.filter((d) => num(d.spend) > 0).length || days.length;
  const pacingResult = computePacing({
    spend,
    dailyBudget: row.daily_budget,
    lifetimeBudget: num(row.lifetime_budget),
    daysElapsed: row.lifetime_budget
      ? daysElapsedSince(row.start_time, row.stop_time) || deliveredDays
      : deliveredDays,
    totalDays: daysBetween(row.start_time, row.stop_time),
  });
  // Campaign.pacing stays a number for existing consumers; the full object is
  // carried alongside so the UI can explain "no budget" instead of showing 0%.
  const pacing = pacingResult.percent ?? 0;

  // spark: last ≤7 daily spends normalized 0–100, left-padded to 7 like seeded rows
  const last7 = days.slice(-7).map((d) => d.spend);
  const max = Math.max(...last7, 0);
  const spark = Array(Math.max(0, 7 - last7.length))
    .fill(0)
    .concat(last7.map((s) => (max > 0 ? Math.round((s / max) * 100) : 0)));

  // Reported purchase VALUE. If the account tracks no purchases this stays 0,
  // and every consumer must render revenue/ROAS as N/A rather than zero.
  const convValue = days.reduce((s, d) => s + num((d as any).conv_value), 0);
  const revenueReported = convValue > 0;
  // Unique reach can't be summed across days (same people recur), so we report
  // the peak single-day reach and label it as such rather than inventing a total.
  const reach = Math.max(0, ...days.map((d) => num((d as any).reach)));
  const freqVals = days.map((d) => num((d as any).frequency)).filter((n) => n > 0);
  const frequency = freqVals.length ? +(freqVals.reduce((a, b) => a + b, 0) / freqVals.length).toFixed(2) : undefined;

  return {
    id: `${LIVE_PREFIX}${row.id}`,
    metaId: row.id,
    name: row.name,
    platform: "meta",
    status,
    objective: row.objective || "—",
    spend: Math.round(spend),
    revenue: Math.round(revenueReported ? convValue : 0),
    roas: revenueReported && spend > 0 ? +(convValue / spend).toFixed(2) : 0,
    ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : 0,
    cpc: clicks > 0 ? +(spend / clicks).toFixed(2) : 0,
    conv,
    pacing,
    pacingDetail: pacingResult,
    health: healthOf({
      status,
      revenueTracked: revenueReported,
      roas: revenueReported && spend > 0 ? convValue / spend : 0,
      ctrTrend: days.map((d) => num(d.ctr)),
      impressions,
    }),
    note: row.data_source === "upload" ? UPLOAD_NOTE : "Live · Meta Graph API",
    spark,
    impressions,
    reach: reach > 0 ? reach : undefined,
    frequency,
    cpm: impressions > 0 ? +((spend / impressions) * 1000).toFixed(2) : undefined,
    cpa: conv > 0 ? +(spend / conv).toFixed(2) : undefined,
    conversionValue: revenueReported ? Math.round(convValue) : undefined,
    // From the ad account itself (via the cached account identity), never an
    // env var — a different account must not require a config change.
    currency: row.account_currency || undefined,
    dateStart: days.length ? String(days[0].date) : undefined,
    dateEnd: days.length ? String(days[days.length - 1].date) : undefined,
  };
}

const LIVE_SELECT_ONE = (metaId: string) => getSql()`
  SELECT c.id, c.name, c.status, c.objective, c.daily_budget,
         c.effective_status, c.lifetime_budget, c.start_time, c.stop_time, c.data_source,
         COALESCE(json_agg(json_build_object(
           'date', to_char(m.date, 'YYYY-MM-DD'),
           'spend', m.spend, 'impressions', m.impressions, 'clicks', m.clicks,
           'conversions', m.conversions, 'ctr', m.ctr, 'cpc', m.cpc, 'roas', m.roas,
             'cpm', m.cpm, 'reach', m.reach, 'frequency', m.frequency, 'conv_value', m.conv_value
         ) ORDER BY m.date) FILTER (WHERE m.date IS NOT NULL), '[]') AS metrics
  FROM meta_campaigns c
  LEFT JOIN meta_daily_metrics m ON m.campaign_id = c.id
  WHERE c.id = ${metaId} AND c.ad_account_id = ${currentAccountId()}
  GROUP BY c.id, c.name, c.status, c.objective, c.daily_budget,
           c.effective_status, c.lifetime_budget, c.start_time, c.stop_time, c.data_source`;

/**
 * Every ad account this token can actually read — discovered from the
 * platform, never from configuration. A client granting Partner access to our
 * business (Business Settings → Partners → share ad account → View
 * performance) appears here automatically on the next call. No App Review, no
 * new token, no code change.
 */
export type AccessibleAccount = {
  id: string;            // digits only, no "act_" prefix
  name: string;
  currency: string;
  timezone: string;
  status: number;        // 1 = active, 2 = disabled, 3 = unsettled, ...
  business: string | null;
  /** Set when this account came from an OAuth connection, so the UI knows it
   *  can be disconnected. null for accounts reached via the env credential. */
  connectionId?: string | null;
};

export async function fetchAccessibleAdAccounts(): Promise<AccessibleAccount[]> {
  if (!currentToken()) return [];
  const token = currentToken();
  const build = (fields: string) =>
    `${graphBase()}/me/adaccounts?fields=${fields}&limit=200&access_token=${encodeURIComponent(token)}`;

  // `business` needs business_management, which an OAuth ads_read token does not
  // carry. It is only a display label, so fall back rather than fail the whole
  // account list. System User tokens keep showing it.
  const base = "account_id,name,currency,timezone_name,account_status";
  let rows: any[];
  try {
    rows = await graphGetAll(build(`${base},business{id,name}`));
  } catch (e: any) {
    if (e?.code === 100 || e?.kind === "permission") rows = await graphGetAll(build(base));
    else throw e;
  }
  return rows.map((r: any) => ({
    id: String(r.account_id ?? String(r.id ?? "").replace(/^act_/, "")),
    name: String(r.name ?? r.account_id ?? "Ad account"),
    currency: String(r.currency ?? "USD"),
    timezone: String(r.timezone_name ?? "UTC"),
    status: Number(r.account_status ?? 0),
    business: r?.business?.name ? String(r.business.name) : null,
  }));
}

/** The connected account's currency, resolved from the platform (cached). */
export async function accountCurrency(): Promise<string> {
  const info = await fetchAccountInfo();
  return info?.currency ?? process.env.META_CURRENCY ?? "USD";
}

export async function loadLiveCampaigns(): Promise<Campaign[]> {
  // Bring the schema up to date FIRST: without ad_account_id the scoped query
  // below throws and the unscoped fallback would mix accounts together.
  await ensureUploadTables();
  await ensureMetaSchema().catch(() => {});
  let rows: Record<string, any>[];
  try {
    rows = (await loadLiveCampaignRowsFull()) as Record<string, any>[];
  } catch {
    try {
      // Columns from a newer migration aren't present yet — degrade to the
      // original set rather than returning zero campaigns.
      rows = (await loadLiveCampaignRowsLegacy()) as Record<string, any>[];
    } catch {
      // ad_account_id not migrated yet: read unscoped so an existing install
      // keeps working. Scoping resumes as soon as the column exists.
      rows = (await loadLiveCampaignRowsUnscoped()) as Record<string, any>[];
    }
  }
  const cur = await accountCurrency();
  return rows.map((r) =>
    toCampaign({
      id: String(r.id),
      name: String(r.name),
      status: String(r.status ?? "ACTIVE"),
      effective_status: r.effective_status ? String(r.effective_status) : null,
      objective: String(r.objective ?? "—"),
      daily_budget: num(r.daily_budget) || budgetCache[String(r.id)] || 0,
      lifetime_budget: num(r.lifetime_budget),
      start_time: r.start_time ? String(r.start_time) : null,
      stop_time: r.stop_time ? String(r.stop_time) : null,
      data_source: r.data_source ? String(r.data_source) : null,
      metrics: normalizeMetrics(r.metrics),
      account_currency: cur,
    })
  );
}

let budgetCache: Record<string, number> = {};

async function loadLiveCampaignRowsFull() {
  // effective_status, the lifetime budget and the flight window are selected
  // here (not just declared on LiveRow) so campaign pacing has a denominator
  // for accounts whose budgets are lifetime rather than daily. A database
  // predating those columns throws and falls back to the legacy query.
  const rows = (await getSql()`
    SELECT c.id, c.name, c.status, c.objective, c.daily_budget,
           c.effective_status, c.lifetime_budget, c.start_time, c.stop_time, c.data_source,
           COALESCE(json_agg(json_build_object(
             'date', to_char(m.date, 'YYYY-MM-DD'),
             'spend', m.spend, 'impressions', m.impressions, 'clicks', m.clicks,
             'conversions', m.conversions, 'ctr', m.ctr, 'cpc', m.cpc, 'roas', m.roas,
             'cpm', m.cpm, 'reach', m.reach, 'frequency', m.frequency, 'conv_value', m.conv_value
           ) ORDER BY m.date) FILTER (WHERE m.date IS NOT NULL), '[]') AS metrics
    FROM meta_campaigns c
    LEFT JOIN meta_daily_metrics m ON m.campaign_id = c.id
    WHERE c.ad_account_id = ${currentAccountId()}
    GROUP BY c.id, c.name, c.status, c.objective, c.daily_budget,
             c.effective_status, c.lifetime_budget, c.start_time, c.stop_time, c.data_source
    ORDER BY c.name`) as unknown as Record<string, any>[];
  await loadBudgetCache();
  return rows;
}

/** Original column set — works before any of the later migrations are run. */
async function loadLiveCampaignRowsLegacy() {
  const rows = (await getSql()`
    SELECT c.id, c.name, c.status, c.objective, c.daily_budget,
           COALESCE(json_agg(json_build_object(
             'date', to_char(m.date, 'YYYY-MM-DD'),
             'spend', m.spend, 'impressions', m.impressions, 'clicks', m.clicks,
             'conversions', m.conversions, 'ctr', m.ctr, 'cpc', m.cpc, 'roas', m.roas
           ) ORDER BY m.date) FILTER (WHERE m.date IS NOT NULL), '[]') AS metrics
    FROM meta_campaigns c
    LEFT JOIN meta_daily_metrics m ON m.campaign_id = c.id
    WHERE c.ad_account_id = ${currentAccountId()}
    GROUP BY c.id, c.name, c.status, c.objective, c.daily_budget
    ORDER BY c.name`) as unknown as Record<string, any>[];
  await loadBudgetCache();
  return rows;
}

/** Pre-scoping fallback: no ad_account_id column yet. */
async function loadLiveCampaignRowsUnscoped() {
  const rows = (await getSql()`
    SELECT c.id, c.name, c.status, c.objective, c.daily_budget,
           COALESCE(json_agg(json_build_object(
             'date', to_char(m.date, 'YYYY-MM-DD'),
             'spend', m.spend, 'impressions', m.impressions, 'clicks', m.clicks,
             'conversions', m.conversions, 'ctr', m.ctr, 'cpc', m.cpc, 'roas', m.roas
           ) ORDER BY m.date) FILTER (WHERE m.date IS NOT NULL), '[]') AS metrics
    FROM meta_campaigns c
    LEFT JOIN meta_daily_metrics m ON m.campaign_id = c.id
    GROUP BY c.id, c.name, c.status, c.objective, c.daily_budget
    ORDER BY c.name`) as unknown as Record<string, any>[];
  await loadBudgetCache();
  return rows;
}

async function loadBudgetCache() {
  try {
    const b = (await getSql()`
      SELECT campaign_id, COALESCE(SUM(daily_budget), 0)::float AS total
      FROM meta_adsets GROUP BY campaign_id`) as unknown as Record<string, any>[];
    budgetCache = Object.fromEntries(b.map((r) => [String(r.campaign_id), num(r.total)]));
  } catch {
    budgetCache = {}; // adset budget column not migrated yet
  }
}

export async function loadLiveCampaign(liveId: string): Promise<Campaign | null> {
  if (!liveId.startsWith(LIVE_PREFIX)) return null;
  const metaId = liveId.slice(LIVE_PREFIX.length);
  await ensureUploadTables();
  await ensureAccountForCampaign(metaId);
  let rows: Record<string, any>[];
  try {
    rows = (await LIVE_SELECT_ONE(metaId)) as unknown as Record<string, any>[];
  } catch {
    rows = (await getSql()`
      SELECT c.id, c.name, c.status, c.objective, c.daily_budget,
             COALESCE(json_agg(json_build_object(
               'date', to_char(m.date, 'YYYY-MM-DD'),
               'spend', m.spend, 'impressions', m.impressions, 'clicks', m.clicks,
               'conversions', m.conversions, 'ctr', m.ctr, 'cpc', m.cpc, 'roas', m.roas
             ) ORDER BY m.date) FILTER (WHERE m.date IS NOT NULL), '[]') AS metrics
      FROM meta_campaigns c
      LEFT JOIN meta_daily_metrics m ON m.campaign_id = c.id
      WHERE c.id = ${metaId} AND c.ad_account_id = ${currentAccountId()}
      GROUP BY c.id, c.name, c.status, c.objective, c.daily_budget`) as unknown as Record<string, any>[];
  }
  if (!rows.length) return null;
  const r = rows[0];
  return toCampaign({
    id: String(r.id),
    name: String(r.name),
    status: String(r.status ?? "ACTIVE"),
    effective_status: r.effective_status ? String(r.effective_status) : null,
    objective: String(r.objective ?? "—"),
    daily_budget: num(r.daily_budget),
    lifetime_budget: num(r.lifetime_budget),
    start_time: r.start_time ? String(r.start_time) : null,
    stop_time: r.stop_time ? String(r.stop_time) : null,
    data_source: r.data_source ? String(r.data_source) : null,
    metrics: normalizeMetrics(r.metrics),
    account_currency: await accountCurrency(),
  });
}

export async function loadLiveSeries(
  liveId: string,
  from?: string,
  to?: string
): Promise<DayPoint[]> {
  if (!liveId.startsWith(LIVE_PREFIX)) return [];
  const metaId = liveId.slice(LIVE_PREFIX.length);
  await ensureAccountForCampaign(metaId);
  const rows = (await (async () => {
    try {
      return await selectSeriesFull(metaId, from, to);
    } catch {
      return await selectSeriesLegacy(metaId, from, to);
    }
  })()) as unknown as Record<string, any>[];
  return mapSeries(rows);
}

async function selectSeriesFull(metaId: string, from?: string, to?: string) {
  const sql = getSql();
  return (from && to
    ? await sql`SELECT to_char(date,'YYYY-MM-DD') AS date, spend, conversions, ctr, roas,
                       impressions, clicks, reach, frequency, conv_value
                FROM meta_daily_metrics WHERE campaign_id = ${metaId}
                  AND date BETWEEN ${from} AND ${to} ORDER BY date`
    : await sql`SELECT to_char(date,'YYYY-MM-DD') AS date, spend, conversions, ctr, roas,
                       impressions, clicks, reach, frequency, conv_value
                FROM meta_daily_metrics WHERE campaign_id = ${metaId}
                ORDER BY date`) as unknown as Record<string, any>[];
}

async function selectSeriesLegacy(metaId: string, from?: string, to?: string) {
  const sql = getSql();
  return (from && to
    ? await sql`SELECT to_char(date,'YYYY-MM-DD') AS date, spend, conversions, ctr, roas,
                       impressions, clicks
                FROM meta_daily_metrics WHERE campaign_id = ${metaId}
                  AND date BETWEEN ${from} AND ${to} ORDER BY date`
    : await sql`SELECT to_char(date,'YYYY-MM-DD') AS date, spend, conversions, ctr, roas,
                       impressions, clicks
                FROM meta_daily_metrics WHERE campaign_id = ${metaId}
                ORDER BY date`) as unknown as Record<string, any>[];
}

function mapSeries(rows: Record<string, any>[]): DayPoint[] {
  return rows.map((r) => {
    const spend = num(r.spend);
    const conv = num(r.conversions);
    // Revenue is the REPORTED purchase value, never roas*spend — otherwise a
    // campaign with no purchase tracking would show fabricated revenue.
    const revenue = num(r.conv_value);
    return {
      day: prettyDay(String(r.date)),
      date: String(r.date),
      ctr: +num(r.ctr).toFixed(2),
      cpa: conv > 0 ? +(spend / conv).toFixed(1) : 0,
      spend: Math.round(spend),
      revenue: Math.round(revenue),
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      conversions: conv,
      reach: num(r.reach),
      frequency: num(r.frequency),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════
   ADSET + AD LEVEL — the drill-down the reasoning engine needs.
   Meta's insights API reports `frequency` and `reach` at adset/ad level,
   which is what powers frequency-basis and CTR-decay fatigue detection
   WITHOUT needing revenue. That matters for accounts with no purchase
   pixel: ROAS stays 0 (honestly), but fatigue is still detectable.
   ═══════════════════════════════════════════════════════════════════ */

export type MetaAdsetShell = {
  id: string; campaignId: string; name: string; status: string; dailyBudget: number;
  /** Ad-set-level pacing needs the same inputs as campaign pacing. */
  effectiveStatus: string; lifetimeBudget: number;
  startTime: string | null; stopTime: string | null;
  /** What this ad set optimises for, and where it sends people. These decide
   *  what counts as a "result" — a WhatsApp ad set's result is a messaging
   *  conversation, not a purchase. */
  optimizationGoal: string; destinationType: string;
};
export type MetaAdShell = { id: string; adsetId: string; name: string; format: string; status: string; thumbnail: string; title: string; body: string; permalink: string };

/** Ad sets belonging to ONE campaign: GET /{campaign_id}/adsets.
 *  Parentage comes from the edge we queried, so it cannot be wrong — unlike
 *  the account-wide call, which depends on each row reporting campaign_id. */
export async function fetchAdsetsForCampaign(campaignId: string): Promise<MetaAdsetShell[]> {
  const token = currentToken();
  const url =
    `${graphBase()}/${campaignId}/adsets` +
    `?fields=id,name,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,optimization_goal,destination_type,promoted_object` +
    `&limit=200&access_token=${encodeURIComponent(token)}`;
  const rows = await graphGetAll(url);
  return rows.map((r: any) => ({
    id: String(r.id),
    campaignId, // from the edge, not from the payload
    name: String(r.name ?? r.id),
    status: String(r.status ?? "ACTIVE"),
    effectiveStatus: String(r.effective_status ?? r.status ?? "ACTIVE"),
    dailyBudget: num(r.daily_budget) / 100,
    lifetimeBudget: num(r.lifetime_budget) / 100,
    startTime: r.start_time ? String(r.start_time) : null,
    // Ad sets call it end_time; campaigns call it stop_time.
    stopTime: r.end_time ? String(r.end_time) : null,
    optimizationGoal: String(r.optimization_goal ?? ""),
    // destination_type is not always present; promoted_object often reveals it.
    destinationType: String(
      r.destination_type ??
      (r?.promoted_object?.whatsapp_phone_number ? "WHATSAPP" :
       r?.promoted_object?.page_id && String(r.optimization_goal ?? "").includes("CONVERSATION") ? "MESSENGER" :
       r?.promoted_object?.application_id ? "APP" : "")
    ),
  }));
}

/** Ads belonging to ONE ad set: GET /{adset_id}/ads. */
export async function fetchAdsForAdset(adsetId: string): Promise<MetaAdShell[]> {
  const token = currentToken();
  const url =
    `${graphBase()}/${adsetId}/ads` +
    `?fields=id,name,status,preview_shareable_link,` +
    `creative{object_type,thumbnail_url,image_url,title,body,object_story_spec}` +
    `&limit=200&access_token=${encodeURIComponent(token)}`;
  const rows = await graphGetAll(url);
  return rows.map((r: any) => {
    const cr = r?.creative ?? {};
    const story = cr?.object_story_spec?.link_data ?? cr?.object_story_spec?.video_data ?? {};
    return {
      id: String(r.id),
      adsetId, // from the edge
      name: String(r.name ?? r.id),
      format: mapFormat(cr.object_type),
      status: String(r.status ?? "ACTIVE"),
      thumbnail: String(cr.thumbnail_url ?? cr.image_url ?? story.picture ?? ""),
      title: String(cr.title ?? story.name ?? story.link_description ?? ""),
      body: String(cr.body ?? story.message ?? ""),
      permalink: String(r.preview_shareable_link ?? ""),
    };
  });
}

export async function fetchMetaAdsets(): Promise<MetaAdsetShell[]> {
  const token = currentToken();
  const acct = currentAccountId();
  const url =
    `${graphBase()}/act_${acct}/adsets` +
    `?fields=id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,optimization_goal,destination_type` +
    `&limit=200&access_token=${encodeURIComponent(token)}`;
  const rows = await graphGetAll(url);
  return rows.map((r: any) => ({
    id: String(r.id),
    campaignId: String(r.campaign_id),
    name: String(r.name ?? r.id),
    status: String(r.status ?? "ACTIVE"),
    effectiveStatus: String(r.effective_status ?? r.status ?? "ACTIVE"),
    lifetimeBudget: num(r.lifetime_budget) / 100,
    startTime: r.start_time ? String(r.start_time) : null,
    stopTime: r.end_time ? String(r.end_time) : null,
    dailyBudget: num(r.daily_budget) / 100, // Meta reports minor units
    optimizationGoal: String(r.optimization_goal ?? ""),
    destinationType: String(r.destination_type ?? ""),
  }));
}

// creative.object_type → the app's format vocabulary
function mapFormat(objectType?: string): "Image" | "Video" | "Carousel" {
  const t = String(objectType ?? "").toUpperCase();
  if (t === "VIDEO") return "Video";
  if (t === "SHARE" || t === "DCO") return "Carousel";
  return "Image";
}

export async function fetchMetaAds(): Promise<MetaAdShell[]> {
  const token = currentToken();
  const acct = currentAccountId();
  const url =
    `${graphBase()}/act_${acct}/ads` +
    `?fields=id,name,adset_id,status,preview_shareable_link,` +
    `creative{object_type,thumbnail_url,image_url,title,body,object_story_spec}` +
    `&limit=200&access_token=${encodeURIComponent(token)}`;
  const rows = await graphGetAll(url);
  return rows.map((r: any) => {
    const cr = r?.creative ?? {};
    // Copy can sit either directly on the creative or inside object_story_spec.
    const story = cr?.object_story_spec?.link_data ?? cr?.object_story_spec?.video_data ?? {};
    return {
      id: String(r.id),
      adsetId: String(r.adset_id),
      name: String(r.name ?? r.id),
      format: mapFormat(cr.object_type),
      status: String(r.status ?? "ACTIVE"),
      thumbnail: String(cr.thumbnail_url ?? cr.image_url ?? story.picture ?? ""),
      title: String(cr.title ?? story.name ?? story.link_description ?? ""),
      body: String(cr.body ?? story.message ?? ""),
      permalink: String(r.preview_shareable_link ?? ""),
    };
  });
}

export type MetaLevelRow = {
  entity_id: string;
  date: string;
  spend: number; impressions: number; clicks: number; conversions: number;
  ctr: number; cpc: number; roas: number; frequency: number; reach: number;
  actions: Record<string, number>;
};

async function fetchLevelInsights(
  level: "adset" | "ad", window: FetchWindow,
  objective?: string, goal?: string, dest?: string
): Promise<MetaLevelRow[]> {
  const token = currentToken();
  const acct = currentAccountId();
  const idField = level === "adset" ? "adset_id" : "ad_id";
  void objective;
  const fields = `${idField},spend,impressions,clicks,ctr,cpc,frequency,reach,actions,purchase_roas`;
  const url =
    `${graphBase()}/act_${acct}/insights` +
    `?level=${level}&time_increment=1&fields=${fields}` +
    `${windowParam(window)}&limit=200&access_token=${encodeURIComponent(token)}`;
  const raw = await graphGetAll(url, 20);
  return raw.map((r: any) => ({
    entity_id: String(r[idField]),
    date: String(r.date_start),
    spend: num(r.spend),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    conversions: pickConversions(r.actions, objective, goal, dest),
    ctr: num(r.ctr),
    cpc: num(r.cpc),
    roas: pickRoas(r.purchase_roas),
    frequency: num(r.frequency),
    reach: num(r.reach),
    actions: actionsMap(r.actions),
  }));
}

export const fetchMetaAdsetInsights = (w: FetchWindow, objective?: string, goal?: string, dest?: string) =>
  fetchLevelInsights("adset", w, objective, goal, dest);
export const fetchMetaAdInsights = (w: FetchWindow, objective?: string, goal?: string, dest?: string) =>
  fetchLevelInsights("ad", w, objective, goal, dest);

/** The ad account's reporting currency — so the UI never mislabels ₹ as $. */
export async function fetchAccountCurrency(): Promise<string> {
  const token = currentToken();
  const acct = currentAccountId();
  try {
    const json = await graphGet(
      `${graphBase()}/act_${acct}?fields=currency&access_token=${encodeURIComponent(token)}`
    );
    return String(json?.currency ?? "USD");
  } catch {
    return "USD";
  }
}

/* ---------------- readers: Neon rows → the app's AdSet / AdItem ---------------- */

const pctDelta = (now: number, then: number) =>
  then === 0 ? (now === 0 ? "stable" : "new") : `${now >= then ? "↑" : "↓"}${Math.abs(Math.round(((now - then) / then) * 100))}%`;

const avg = (a: number[]) => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : 0);

// Consecutive-day CTR decline, same rule the engine uses on seeded data.
function consecutiveFalls(trend: number[]): number {
  let falls = 0;
  for (let i = trend.length - 1; i > 0; i--) {
    if (trend[i] < trend[i - 1]) falls++;
    else break;
  }
  return falls;
}

type DailyRow = {
  date: string; spend: number; impressions: number; clicks: number;
  conversions: number; ctr: number; cpc: number; roas: number;
  frequency: number; reach: number;
};

function parseDaily(v: unknown): DailyRow[] {
  if (Array.isArray(v)) return v as DailyRow[];
  if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

/**
 * Live adsets for a campaign, mapped into the app's AdSet type.
 *
 * Honest gaps, deliberately not invented:
 *  - `revenue`/`roas` are 0 unless the account reports purchase_roas.
 *  - `reachPct` (share of the TARGET audience reached) is not derivable from
 *    the insights API — there's no audience-size denominator. Left at 0 and
 *    surfaced in `note` rather than estimated.
 */
/**
 * Live ad sets for a campaign, restricted to a date range.
 *
 * The range is applied in the JOIN, not after aggregation: an ad set with no
 * delivery in the window is still listed, but with zero metrics for that
 * window rather than its all-time totals. Aggregating every stored day here
 * would make the ad set tables show a different period than the KPI cards.
 */
export async function loadLiveAdsets(
  liveCampaignId: string,
  since?: string,
  until?: string
): Promise<AdSet[]> {
  if (!liveCampaignId.startsWith(LIVE_PREFIX)) return [];
  const campaignId = liveCampaignId.slice(LIVE_PREFIX.length);
  await ensureAccountForCampaign(campaignId);
  const sql = getSql();
  // Open-ended defaults keep the "whole history" behaviour for callers that
  // don't specify a window.
  const lo = since ?? "1970-01-01";
  const hi = until ?? "9999-12-31";

  let setRows: Record<string, any>[];
  try {
    setRows = (await sql`
    SELECT s.id, s.name, s.status, s.effective_status, s.daily_budget, s.lifetime_budget,
           s.start_time, s.stop_time, s.optimization_goal, s.destination_type,
           COALESCE(json_agg(json_build_object(
             'date', to_char(d.date,'YYYY-MM-DD'), 'spend', d.spend,
             'impressions', d.impressions, 'clicks', d.clicks, 'conversions', d.conversions,
             'ctr', d.ctr, 'cpc', d.cpc, 'roas', d.roas,
             'frequency', d.frequency, 'reach', d.reach, 'actions', d.actions
           ) ORDER BY d.date) FILTER (WHERE d.date IS NOT NULL), '[]') AS daily
    FROM meta_adsets s
    JOIN meta_campaigns c2 ON c2.id = s.campaign_id AND c2.ad_account_id = ${currentAccountId()}
    LEFT JOIN meta_adset_daily d ON d.adset_id = s.id AND d.date BETWEEN ${lo} AND ${hi}
    WHERE s.campaign_id = ${campaignId}
    GROUP BY s.id, s.name, s.status, s.effective_status, s.daily_budget, s.lifetime_budget,
             s.start_time, s.stop_time, s.optimization_goal, s.destination_type
    ORDER BY s.name`) as unknown as Record<string, any>[];
  } catch {
    setRows = (await sql`
      SELECT s.id, s.name, s.status,
             COALESCE(json_agg(json_build_object(
               'date', to_char(d.date,'YYYY-MM-DD'), 'spend', d.spend,
               'impressions', d.impressions, 'clicks', d.clicks, 'conversions', d.conversions,
               'ctr', d.ctr, 'cpc', d.cpc, 'roas', d.roas,
               'frequency', d.frequency, 'reach', d.reach
             ) ORDER BY d.date) FILTER (WHERE d.date IS NOT NULL), '[]') AS daily
      FROM meta_adsets s
      JOIN meta_campaigns c ON c.id = s.campaign_id AND c.ad_account_id = ${currentAccountId()}
      LEFT JOIN meta_adset_daily d ON d.adset_id = s.id AND d.date BETWEEN ${lo} AND ${hi}
      WHERE s.campaign_id = ${campaignId}
      GROUP BY s.id, s.name, s.status
      ORDER BY s.name`) as unknown as Record<string, any>[];
  }

  let adRows: Record<string, any>[];
  try {
    adRows = (await sql`
    SELECT a.id, a.adset_id, a.name, a.format, a.thumbnail_url, a.title, a.body, a.permalink,
           COALESCE(json_agg(json_build_object(
             'date', to_char(d.date,'YYYY-MM-DD'), 'spend', d.spend,
             'impressions', d.impressions, 'clicks', d.clicks, 'conversions', d.conversions,
             'ctr', d.ctr, 'roas', d.roas, 'frequency', d.frequency
           ) ORDER BY d.date) FILTER (WHERE d.date IS NOT NULL), '[]') AS daily
    FROM meta_ads a
    JOIN meta_adsets s ON s.id = a.adset_id
    LEFT JOIN meta_ad_daily d ON d.ad_id = a.id AND d.date BETWEEN ${lo} AND ${hi}
    WHERE s.campaign_id = ${campaignId}
    GROUP BY a.id, a.adset_id, a.name, a.format, a.thumbnail_url, a.title, a.body, a.permalink`) as unknown as Record<string, any>[];
  } catch {
    adRows = (await sql`
      SELECT a.id, a.adset_id, a.name, a.format,
             COALESCE(json_agg(json_build_object(
               'date', to_char(d.date,'YYYY-MM-DD'), 'spend', d.spend,
               'impressions', d.impressions, 'clicks', d.clicks, 'conversions', d.conversions,
               'ctr', d.ctr, 'roas', d.roas, 'frequency', d.frequency
             ) ORDER BY d.date) FILTER (WHERE d.date IS NOT NULL), '[]') AS daily
      FROM meta_ads a
      JOIN meta_adsets s ON s.id = a.adset_id
      LEFT JOIN meta_ad_daily d ON d.ad_id = a.id AND d.date BETWEEN ${lo} AND ${hi}
      WHERE s.campaign_id = ${campaignId}
      GROUP BY a.id, a.adset_id, a.name, a.format`) as unknown as Record<string, any>[];
  }

  return setRows.map((r) => {
    const daily = parseDaily(r.daily);
    const spend = daily.reduce((s, d) => s + d.spend, 0);
    const revenue = daily.reduce((s, d) => s + d.roas * d.spend, 0);
    const clicks = daily.reduce((s, d) => s + d.clicks, 0);
    const impressions = daily.reduce((s, d) => s + d.impressions, 0);
    const conv = daily.reduce((s, d) => s + d.conversions, 0);
    const ctr = impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : 0;
    const freq = +avg(daily.map((d) => d.frequency)).toFixed(1);
    const roas = spend > 0 ? +(revenue / spend).toFixed(1) : 0;

    const ctrTrend = daily.slice(-7).map((d) => +num(d.ctr).toFixed(2));
    // null = "no conversions that day", so charts show a gap instead of a
    // zero line that looks like a real CPA of 0.
    const cpaTrend = daily.slice(-7).map((d) => (d.conversions > 0 ? +(d.spend / d.conversions).toFixed(1) : null));

    const last7 = daily.slice(-7), prev7 = daily.slice(-14, -7);
    const kpiDeltas = {
      spend: pctDelta(avg(last7.map((d) => d.spend)), avg(prev7.map((d) => d.spend))),
      revenue: pctDelta(avg(last7.map((d) => d.roas * d.spend)), avg(prev7.map((d) => d.roas * d.spend))),
      roas: roas === 0 ? "not reported" : `${roas}x`,
      ctr: pctDelta(avg(last7.map((d) => d.ctr)), avg(prev7.map((d) => d.ctr))),
      cpc: pctDelta(avg(last7.map((d) => d.cpc)), avg(prev7.map((d) => d.cpc))),
      freq: freq > 7 ? `${freq} — cap soon` : `${freq}`,
    };

    // Rules decide health from real signals — no AI, no invented numbers.
    const falls = consecutiveFalls(ctrTrend);
    let health: AdSet["health"] = "good";
    let healthLabel = "Stable";
    if (!daily.length) { health = "good"; healthLabel = "No data in range"; }
    else if (String(r.status).toUpperCase() !== "ACTIVE") { health = "paused"; healthLabel = "Paused"; }
    else if (falls >= 3) { health = "critical"; healthLabel = "CTR declining"; }
    else if (freq > 7) { health = "watch"; healthLabel = "Freq risk"; }

    const ads: AdItem[] = adRows
      .filter((a) => String(a.adset_id) === String(r.id))
      .map((a) => {
        const ad = parseDaily(a.daily);
        const aSpend = ad.reduce((s, d) => s + d.spend, 0);
        const aClicks = ad.reduce((s, d) => s + d.clicks, 0);
        const aImpr = ad.reduce((s, d) => s + d.impressions, 0);
        const aCtr = aImpr > 0 ? +((aClicks / aImpr) * 100).toFixed(2) : 0;
        const aFreq = ad.length ? +avg(ad.map((d) => d.frequency)).toFixed(1) : null;
        // The ad's OWN first-week CTR — baseline for frequency-free decay detection.
        const wk1 = ad.slice(0, 7);
        const wk1Impr = wk1.reduce((s, d) => s + d.impressions, 0);
        const ctrWeek1 = wk1Impr > 0 ? +((wk1.reduce((s, d) => s + d.clicks, 0) / wk1Impr) * 100).toFixed(2) : undefined;
        const aRev = ad.reduce((s, d) => s + d.roas * d.spend, 0);
        return {
          id: String(a.id),
          name: String(a.name),
          format: (String(a.format) as AdItem["format"]) ?? "Image",
          spend: Math.round(aSpend),
          ctr: aCtr,
          roas: aSpend > 0 ? +(aRev / aSpend).toFixed(1) : 0,
          freq: aFreq,
          ctrWeek1,
          conv: ad.reduce((s, d) => s + d.conversions, 0),
          thumbnail: String(a.thumbnail_url ?? "") || undefined,
          title: String(a.title ?? "") || undefined,
          body: String(a.body ?? "") || undefined,
          permalink: String(a.permalink ?? "") || undefined,
          action: (ctrWeek1 && aCtr < ctrWeek1 * 0.6 ? "Pause" : "Monitor") as AdItem["action"],
          rank: "mid" as AdItem["rank"],
          rankLabel: ctrWeek1 && aCtr < ctrWeek1 * 0.6 ? "Decay" : "—",
        };
      })
      .sort((a, b) => b.spend - a.spend);

    if (ads.length) {
      ads[0].rank = "top";
      ads[0].rankLabel = ads[0].rankLabel === "Decay" ? "Decay" : "#1";
    }

    const body = !daily.length
      ? `No delivery recorded for this ad set between ${lo} and ${hi}.`
      : falls >= 3
        ? `CTR has fallen ${falls} consecutive days (${ctrTrend[0]}% → ${ctrTrend[ctrTrend.length - 1]}%) on $${Math.round(spend)} spend. Frequency is ${freq}, so this reads as creative decay rather than audience saturation.`
        : freq > 7
        ? `Frequency ${freq} across ${impressions.toLocaleString()} impressions signals repeat exposure. CTR is holding at ${ctr}% — worth fresh creative before it degrades.`
        : `${conv} conversions on $${Math.round(spend)} spend at ${ctr}% CTR, frequency ${freq}. No decline pattern in the last ${ctrTrend.length} days.`;

    // Sum every action type across the window, so each ad set can report the
    // result that matches ITS optimisation goal.
    const actionTotals: Record<string, number> = {};
    for (const d of daily) {
      const a = (d as unknown as { actions?: Record<string, number> }).actions ?? {};
      for (const [k, v] of Object.entries(a)) actionTotals[k] = (actionTotals[k] ?? 0) + Number(v || 0);
    }
    const ladder = resultLadder(undefined, String(r.optimization_goal ?? ""), String(r.destination_type ?? ""));
    const ownResults = ladder.types.reduce((acc, t) => acc || actionTotals[t] || 0, 0);

    // Ad-set-level pacing, on the same time-aware basis as campaign pacing.
    const setDeliveredDays = daily.filter((d: any) => num(d.spend) > 0).length || daily.length;
    const setPacing = computePacing({
      spend,
      dailyBudget: num(r.daily_budget),
      lifetimeBudget: num(r.lifetime_budget),
      daysElapsed: num(r.lifetime_budget)
        ? daysElapsedSince(r.start_time, r.stop_time) || setDeliveredDays
        : setDeliveredDays,
      totalDays: daysBetween(r.start_time, r.stop_time),
    });

    return {
      id: `${LIVE_PREFIX}${r.id}`,
      campaignId: liveCampaignId,
      status: mapMetaStatus(r.effective_status, r.status),
      pacing: setPacing.percent ?? 0,
      pacingDetail: setPacing,
      actionTotals,
      resultLabel: ladder.label,
      resultBasis: ladder.basis,
      results: ownResults,
      costPerResult: ownResults > 0 ? +(spend / ownResults).toFixed(2) : null,
      name: String(r.name),
      health,
      healthLabel,
      spend: Math.round(spend),
      revenue: Math.round(revenue),
      roas,
      ctr,
      cpc: clicks > 0 ? +(spend / clicks).toFixed(2) : 0,
      freq,
      conv,
      reachPct: 0, // share-of-audience needs a denominator the API doesn't give
      // Absolute unique people reached — peak daily reach across the window.
      reachAbs: Math.max(0, ...daily.map((d) => d.reach || 0)),
      note: roas === 0 ? "Revenue not reported for this ad set" : "Reported metrics",
      optimizationGoal: String(r.optimization_goal ?? ""),
      destinationType: String(r.destination_type ?? ""),
      ctrTrend,
      cpaTrend,
      kpiDeltas,
      ads,
      insight: { tag: falls >= 3 ? "issue" : freq > 7 ? "watch" : "rec", title: healthLabel, body },
    };
  });
}

type AccountInfo = { id: string; name: string; currency: string; timezone: string };

// Account identity changes almost never, but /api/db/accounts is hit on every
// page load. Cache it: in-memory for the life of the lambda, and persisted in
// sync_log so a cold start reads the DB instead of calling Meta again.
const ACCOUNT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// MUST be keyed by ad account. A single shared slot made the first account
// fetched win for every other one — showing its name, and worse, its CURRENCY
// and TIMEZONE against another account's numbers.
const accountMemo = new Map<string, { at: number; value: AccountInfo }>();

/** sync_log key for one account's cached identity. */
const accountCacheKey = (acct: string) => `account:${acct}`;

async function readAccountCache(acct: string): Promise<AccountInfo | null> {
  try {
    const rows = (await getSql()`
      SELECT detail, last_synced FROM sync_log WHERE source = ${accountCacheKey(acct)}`) as unknown as any[];
    if (!rows.length) return null;
    const age = Date.now() - new Date(String(rows[0].last_synced)).getTime();
    if (age > ACCOUNT_TTL_MS) return null;
    const value = JSON.parse(String(rows[0].detail)) as AccountInfo;
    // Belt and braces: never hand back a row that belongs to another account.
    return String(value.id) === String(acct) ? value : null;
  } catch {
    return null;
  }
}

async function writeAccountCache(v: AccountInfo): Promise<void> {
  try {
    await getSql()`
      INSERT INTO sync_log (source, last_synced, detail)
      VALUES (${accountCacheKey(v.id)}, now(), ${JSON.stringify(v)})
      ON CONFLICT (source) DO UPDATE SET last_synced = now(), detail = EXCLUDED.detail`;
  } catch {
    // sync_log missing — caching is an optimisation, not a requirement
  }
}

/** The connected ad account's identity. Cached: at most one Graph API call
 *  per 6 hours, not one per page load. Pass force=true to refresh (the sync
 *  route does this so a currency or name change is picked up immediately). */
export async function fetchAccountInfo(force = false): Promise<AccountInfo | null> {
  const acct = currentAccountId();

  // An uploaded batch is an ad account with no token behind it. Its identity
  // lives in upload_batches, so resolve it here — before the credential check
  // — or every uploaded account would fall back to USD/UTC and the wrong name.
  const { isUploadAccount, getBatch } = await import("./uploads");
  if (isUploadAccount(acct)) {
    const batch = await getBatch(acct);
    return batch
      ? { id: acct, name: batch.label, currency: batch.currency, timezone: batch.timezone }
      : null;
  }

  if (!metaConfigured()) return null;

  if (!force) {
    const memo = accountMemo.get(acct);
    if (memo && Date.now() - memo.at < ACCOUNT_TTL_MS) return memo.value;
    const cached = await readAccountCache(acct);
    if (cached) { accountMemo.set(acct, { at: Date.now(), value: cached }); return cached; }
  }

  const token = currentToken();
  try {
    const json = await graphGet(
      `${graphBase()}/act_${acct}?fields=name,currency,timezone_name&access_token=${encodeURIComponent(token)}`
    );
    const value: AccountInfo = {
      id: acct,
      name: String(json?.name ?? `act_${acct}`),
      currency: String(json?.currency ?? "USD"),
      // Meta reports insights in the AD ACCOUNT's timezone, not UTC. Carrying
      // it means dates can be labelled correctly for any account.
      timezone: String(json?.timezone_name ?? "UTC"),
    };
    accountMemo.set(acct, { at: Date.now(), value });
    await writeAccountCache(value);
    return value;
  } catch {
    // Readable via insights but not via /act_X — still usable, don't cache.
    // Unreadable via /act_X but usable via insights. META_CURRENCY is only a
    // last-resort override, never the primary source.
    return { id: acct, name: `act_${acct}`, currency: process.env.META_CURRENCY ?? "USD", timezone: "UTC" };
  }
}

/** Real last-sync timestamp from sync_log — replaces the seeded "Today 02:00". */
export async function getLastSynced(): Promise<string | null> {
  // An uploaded batch was never "synced" — the honest timestamp is when the
  // file was uploaded, which is also what the staleness warning should use.
  const { isUploadAccount, getBatch } = await import("./uploads");
  if (isUploadAccount(currentAccountId())) {
    const batch = await getBatch(currentAccountId());
    return batch?.uploadedAt ?? null;
  }
  try {
    // Prefer this account's own row; fall back to the global marker for
    // databases synced before per-account tracking existed.
    const key = `meta:${currentAccountId()}`;
    const rows = (await getSql()`
      SELECT source, last_synced FROM sync_log
      WHERE source IN (${key}, 'meta')
      ORDER BY source DESC LIMIT 1`) as unknown as any[];
    return rows.length ? String(rows[0].last_synced) : null;
  } catch {
    return null;
  }
}

/** Every live ad set in the account with its parent campaign — used to explain
 *  in the UI why a given campaign shows none (wrong parent, or none exist). */
export async function listLiveAdsetsBrief(): Promise<
  { id: string; name: string; campaignId: string; campaignName: string | null; days: number }[]
> {
  try {
    const rows = (await getSql()`
      SELECT s.id, s.name, s.campaign_id, c.name AS campaign_name,
             count(d.date)::int AS days
      FROM meta_adsets s
      JOIN meta_campaigns c ON c.id = s.campaign_id AND c.ad_account_id = ${currentAccountId()}
      LEFT JOIN meta_adset_daily d ON d.adset_id = s.id
      GROUP BY s.id, s.name, s.campaign_id, c.name
      ORDER BY s.name`) as unknown as any[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      campaignId: String(r.campaign_id),
      campaignName: r.campaign_name ? String(r.campaign_name) : null,
      days: Number(r.days) || 0,
    }));
  } catch {
    return [];
  }
}
