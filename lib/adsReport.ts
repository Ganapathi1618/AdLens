// ── Uploaded ad report → the app's own shapes ───────────────────────
// One export file becomes campaigns, ad sets, ads and daily rows in exactly
// the shape lib/meta.ts already reads. Nothing downstream — the reasoning
// engine, pacing, period comparison, the AI pipeline — learns that the data
// arrived as a file rather than over the Graph API.
//
// The load-bearing rule: this module NEVER invents a metric. A column that is
// not in the file produces a missing capability and a warning, never a zero
// that reads like a measurement. An account with no impressions column has no
// CTR — it does not have a CTR of 0%.

import {
  parseDelimited, parseNumber, parseDate, detectDateFormat, detectNumberFormat,
  type DateFormat, type NumberFormat,
} from "./csv";
import { readXlsx } from "./xlsx";
import {
  FIELD_SPECS, FIELD_BY_KEY, TIER_LABEL, TIER_BLURB,
  type Field, type FieldSpec, type Mapping, type SheetChoice,
  type Level, type Granularity, type Tier, type Capability, type ReportAnalysis,
} from "./reportFields";

// Re-exported so existing importers of this module keep working unchanged.
export {
  FIELD_SPECS, FIELD_BY_KEY, TIER_LABEL, TIER_BLURB,
};
export type {
  Field, FieldSpec, Mapping, SheetChoice,
  Level, Granularity, Tier, Capability, ReportAnalysis,
};

/* ═══════════════════════ fields ═══════════════════════ */

/* ═══════════════════════ header matching ═══════════════════════ */

/**
 * Header aliases in priority order. Earlier entries win, and each header and
 * each field is claimed at most once — so a file carrying both "Amount spent"
 * and "Total Spent" maps the former and reports the latter as unmapped,
 * rather than letting the looser pattern shadow the exact one.
 */
const ALIASES: [Field, RegExp][] = [
  ["date", /^(day|date)$/],
  ["campaign_id", /^campaign id$/],
  ["adset_id", /^ad ?set id$/],
  ["ad_id", /^ad id$/],
  ["campaign_name", /^campaign name$/],
  ["adset_name", /^ad ?set name$/],
  ["ad_name", /^ad name$/],
  ["campaign_name", /^campaign$/],
  ["adset_name", /^ad ?set$/],
  ["ad_name", /^ad$/],

  ["spend", /^amount spent/],
  ["spend", /^(spend|cost|amount)$/],
  ["spend", /^total spent/],

  ["impressions", /^impressions$/],
  ["reach", /^reach$/],
  ["frequency", /^frequency$/],

  ["clicks", /^link clicks$/],
  ["clicks", /^clicks link$/],
  ["clicks", /^unique link clicks$/],
  ["clicks", /^clicks all$/],
  ["clicks", /^clicks$/],

  ["ctr", /^ctr link click through rate$/],
  ["ctr", /^ctr destination link click through rate$/],
  ["ctr", /^(link ctr|ctr all|ctr)$/],
  ["cpc", /^cpc cost per link click$/],
  ["cpc", /^(cpc all|cpc)$/],
  ["cpm", /^cpm/],

  // Value is claimed before the count so a looser conversion pattern can
  // never take "Purchases conversion value".
  ["conv_value", /conversion value$/],
  ["conv_value", /^(purchase value|revenue|total revenue|value)$/],
  ["roas", /purchase roas/],
  ["roas", /^(roas|return on ad spend)$/],
  ["conversions", /^(purchases|website purchases|results|conversions|total conversions|leads)$/],
  ["conversions", /^results /],

  ["objective", /^(objective|campaign objective)$/],
  ["status", /^(delivery|campaign delivery|ad ?set delivery|status|effective status|delivery status)$/],
  ["currency", /^(currency|account currency)$/],
  ["ad_format", /^(ad format|format|creative type)$/],

  ["campaign_budget_type", /^campaign budget type$/],
  ["adset_budget_type", /^ad ?set budget type$/],
  ["campaign_budget", /^campaign budget$/],
  ["adset_budget", /^ad ?set budget$/],
  ["report_start", /^reporting starts$/],
  ["report_end", /^reporting ends$/],
  ["starts", /^(starts|start date|start|flight start)$/],
  ["ends", /^(ends|end date|end|flight end)$/],

  // ── Pacing-tracker vocabulary ──────────────────────────────────────
  // These sheets are hand-built, so the headers are run together and
  // punctuated freely: "Actualspent", "ExpectedDelivered%",
  // "Yesterday'sPacing". normalizeHeader() strips the punctuation but cannot
  // split the words, so the patterns match the concatenated forms too.
  //
  // Ordering matters: the pacing spend column is claimed AFTER the Ads
  // Manager ones above, so a file carrying both keeps "Amount spent".
  ["spend", /^actual ?spent$/],
  ["budget", /^budget$/],
  ["days_total", /^total days$/],
  ["days_elapsed", /^days elapsed$/],
  ["days_left", /^days left$/],
  ["expected_delivered_pct", /^expected ?delivered/],
  ["actual_delivered_pct", /^actual ?delivered/],
  ["budget_left", /^budget ?left$/],
  ["required_daily", /^required ?daily ?needed$/],
  ["required_daily", /^required daily/],
  // "Yesterday'sspent" normalises to "yesterday sspent" — the apostrophe
  // becomes a space and glues the s onto the next word.
  ["yesterday_spend", /^yesterday s?spent$/],
  ["pacing_ratio", /^overall ?pacing$/],
  ["pacing_status", /^pacing status$/],
];

/** Header text reduced to comparable words: "CTR (link click-through rate)" becomes "ctr link click through rate". */
export function normalizeHeader(h: string): string {
  return String(h ?? "")
    .toLowerCase()
    .replace(/[_\-/.]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort column mapping. The user can override every entry before commit. */
export function detectMapping(headers: string[]): Mapping {
  const norm = headers.map(normalizeHeader);
  const mapping: Mapping = {};
  const usedColumn = new Set<number>();

  for (const [field, pattern] of ALIASES) {
    if (mapping[field] !== undefined) continue;
    for (let i = 0; i < norm.length; i++) {
      if (usedColumn.has(i) || !norm[i]) continue;
      if (pattern.test(norm[i])) {
        mapping[field] = i;
        usedColumn.add(i);
        break;
      }
    }
  }
  return mapping;
}

/**
 * Columns that must be SUMMED to produce one field.
 *
 * A pacing tracker splits revenue by vertical — "Tickets Purchase Value",
 * "Birthday Purchase Value" — with no combined column anywhere in the sheet.
 * Mapping one and ignoring the rest would under-report revenue, which is worse
 * than reporting none, so the parts are added instead.
 *
 * Only consulted when the field has NO single mapped column. A file carrying
 * both a total and its parts keeps the total, so nothing is ever double-counted.
 */
export function detectAdditiveColumns(headers: string[], mapping: Mapping): Partial<Record<Field, number[]>> {
  const norm = headers.map(normalizeHeader);
  const used = new Set(Object.values(mapping).filter((v): v is number => typeof v === "number"));
  const out: Partial<Record<Field, number[]>> = {};

  const collect = (field: Field, pattern: RegExp) => {
    if (mapping[field] !== undefined) return;
    const cols: number[] = [];
    for (let i = 0; i < norm.length; i++) {
      if (used.has(i) || !norm[i]) continue;
      if (pattern.test(norm[i])) cols.push(i);
    }
    // One part is not a split — it is just a column the aliases did not know,
    // and treating it as authoritative revenue would be a guess.
    if (cols.length >= 2) {
      out[field] = cols;
      for (const c of cols) used.add(c);
    }
  };

  // Value before count: "tickets purchase value" must not be claimed by the
  // looser purchases pattern.
  collect("conv_value", /purchase value$/);
  collect("conversions", /purchases$/);
  return out;
}

/** ISO currency code embedded in a header, e.g. "Amount spent (USD)". */
export function currencyFromHeaders(headers: string[]): string | null {
  for (const h of headers) {
    const m = String(h ?? "").match(/\(([A-Z]{3})\)\s*$/);
    if (m) return m[1];
  }
  return null;
}

/* ═══════════════════════ reading a file ═══════════════════════ */

export interface ReadResult {
  headers: string[];
  rows: string[][];
  /** The .xlsx sheet actually read, when the workbook had more than one. */
  sheet: string | null;
  sheets: SheetChoice[];
  truncated: boolean;
}

const isBlankRow = (r: string[]) => r.every((c) => String(c ?? "").trim() === "");

/**
 * Read an upload into a header row plus data rows.
 *
 * Exports routinely carry a title block above the real header, so the header
 * is located rather than assumed to be row 1: the first row that matches at
 * least two known field names and has the most non-empty cells wins.
 */
export function readReport(buf: Buffer, filename: string, sheetName?: string, maxRows = 250_000): ReadResult {
  const lower = filename.toLowerCase();
  let grid: string[][];
  let sheets: SheetChoice[] = [];
  let sheet: string | null = null;
  let truncated = false;

  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
    const wb = readXlsx(buf, { maxRows });
    truncated = wb.truncated;
    sheets = wb.sheets.map((s) => ({ name: s.name, rows: s.rows.length, columns: s.rows[0]?.length ?? 0 }));
    const picked = (sheetName ? wb.sheets.find((s) => s.name === sheetName) : undefined)
      // Default to the sheet with the most rows: exports often ship a cover
      // sheet first, and reading it would look like an empty upload.
      ?? wb.sheets.slice().sort((a, b) => b.rows.length - a.rows.length)[0];
    sheet = picked.name;
    grid = picked.rows;
  } else if (lower.endsWith(".xls")) {
    throw new Error("Legacy .xls files aren't supported. Open it and save as .xlsx or CSV.");
  } else {
    const text = buf.toString("utf8");
    const parsed = parseDelimited(text, undefined, maxRows);
    grid = parsed.rows;
    truncated = parsed.truncated;
  }

  grid = grid.filter((r) => !isBlankRow(r));
  if (!grid.length) throw new Error("That file has no rows.");

  let headerIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(grid.length, 25); i++) {
    const candidate = grid[i];
    const mapped = Object.keys(detectMapping(candidate)).length;
    const filled = candidate.filter((c) => String(c ?? "").trim() !== "").length;
    const score = mapped * 100 + filled;
    if (mapped >= 2 && score > bestScore) { bestScore = score; headerIdx = i; }
  }

  const headers = (grid[headerIdx] ?? []).map((h) => String(h ?? "").trim());
  const rows = grid.slice(headerIdx + 1).filter((r) => !isBlankRow(r));
  return { headers, rows, sheet, sheets, truncated };
}

/* ═══════════════════════ analysis ═══════════════════════ */

const cap = (key: string, label: string, available: boolean, reason: string): Capability =>
  ({ key, label, available, reason });

const round2 = (n: number) => Math.round(n * 100) / 100;

export function analyzeReport(read: ReadResult, mappingOverride?: Mapping): ReportAnalysis {
  const { headers, rows } = read;
  const mapping: Mapping = { ...detectMapping(headers), ...(mappingOverride ?? {}) };
  // An override of -1 means "this column is not that field" — drop it.
  for (const k of Object.keys(mapping) as Field[]) {
    const v = mapping[k];
    if (v === undefined || v < 0 || v >= headers.length) delete mapping[k];
  }

  const additive = detectAdditiveColumns(headers, mapping);

  /** Numeric read that also sums split columns. All-empty stays null. */
  const sumAt = (row: string[], f: Field, fmt: NumberFormat): number | null => {
    const i = mapping[f];
    if (i !== undefined) return parseNumber(row[i], fmt);
    const cols = additive[f];
    if (!cols?.length) return null;
    let total: number | null = null;
    for (const c of cols) {
      const v = parseNumber(row[c], fmt);
      if (v !== null) total = (total ?? 0) + v;
    }
    return total;
  };

  const at = (row: string[], f: Field): string => {
    const i = mapping[f];
    return i === undefined ? "" : String(row[i] ?? "").trim();
  };
  const sampleOf = (f: Field, n = 400): string[] => {
    const cols = mapping[f] !== undefined ? [mapping[f]!] : (additive[f] ?? []);
    if (!cols.length) return [];
    const out: string[] = [];
    for (let r = 0; r < rows.length && out.length < n; r++) {
      for (const i of cols) {
        const v = String(rows[r][i] ?? "").trim();
        if (v) { out.push(v); break; }
      }
    }
    return out;
  };

  const errors: string[] = [];
  const warnings: string[] = [];

  if (mapping.spend === undefined) errors.push("No spend column found. Map one to \"Amount spent\" — every analysis needs it.");
  if (mapping.campaign_name === undefined && mapping.campaign_id === undefined) {
    errors.push("No campaign column found. Map one to \"Campaign name\".");
  }
  if (!rows.length) errors.push("That file has a header but no data rows.");

  // Number and date layout are decided per column, from the whole column.
  const numberFormat = detectNumberFormat([...sampleOf("spend"), ...sampleOf("conv_value")]);
  const dateCol: Field | null =
    mapping.date !== undefined ? "date" : mapping.report_start !== undefined ? "report_start" : null;
  const dateProbe = dateCol ? detectDateFormat(sampleOf(dateCol)) : { format: "iso" as DateFormat, ambiguous: false };
  const dateFormat = dateProbe.format;
  if (dateProbe.ambiguous) {
    warnings.push("Dates are written as numbers only (e.g. 01/02/2026) and nothing in the column proves whether day or month comes first. Read as day-first — check the date range below and re-export as YYYY-MM-DD if it is wrong.");
  }

  const currencyCell = mapping.currency !== undefined ? sampleOf("currency")[0] : null;
  const currency = (currencyCell ? currencyCell.toUpperCase().slice(0, 3) : null)
    || currencyFromHeaders(headers)
    || "USD";

  // ── walk the rows once ──────────────────────────────────────────
  const days = new Set<string>();
  const campaignKeys = new Set<string>();
  const adsetKeys = new Set<string>();
  const adKeys = new Set<string>();
  let spendTotal = 0;
  let convTotal = 0, convRows = 0;
  let valueTotal = 0, valueRows = 0;
  let imprTotal = 0, imprRows = 0;
  let clickTotal = 0, clickRows = 0;
  let skipped = 0;
  let badDates = 0;

  for (const row of rows) {
    const campaign = at(row, "campaign_id") || at(row, "campaign_name");
    if (!campaign) { skipped++; continue; }
    const spend = parseNumber(at(row, "spend"), numberFormat);
    if (spend === null) { skipped++; continue; }

    campaignKeys.add(campaign);
    const adset = at(row, "adset_id") || at(row, "adset_name");
    if (adset) adsetKeys.add(`${campaign} ${adset}`);
    const ad = at(row, "ad_id") || at(row, "ad_name");
    if (ad) adKeys.add(`${campaign} ${adset} ${ad}`);

    if (dateCol) {
      const raw = at(row, dateCol);
      const iso = parseDate(raw, dateFormat);
      if (iso) days.add(iso);
      else if (raw) badDates++;
    }

    spendTotal += spend;
    const c = sumAt(row, "conversions", numberFormat);
    if (c !== null) { convTotal += c; convRows++; }
    let v = sumAt(row, "conv_value", numberFormat);
    if (v === null && mapping.roas !== undefined) {
      const r = parseNumber(at(row, "roas"), numberFormat);
      if (r !== null) v = r * spend;
    }
    if (v !== null) { valueTotal += v; valueRows++; }
    const im = parseNumber(at(row, "impressions"), numberFormat);
    if (im !== null) { imprTotal += im; imprRows++; }
    const cl = parseNumber(at(row, "clicks"), numberFormat);
    if (cl !== null) { clickTotal += cl; clickRows++; }
  }

  if (skipped) warnings.push(`${skipped.toLocaleString()} row${skipped === 1 ? "" : "s"} skipped — no campaign name, or no readable spend value.`);
  if (badDates) warnings.push(`${badDates.toLocaleString()} row${badDates === 1 ? "" : "s"} had a date that could not be read.`);

  const sortedDays = Array.from(days).sort();
  const level: Level = adKeys.size ? "ad" : adsetKeys.size ? "adset" : "campaign";
  const granularity: Granularity = sortedDays.length >= 2 ? "daily" : "snapshot";

  const hasFrequency = mapping.frequency !== undefined;
  const hasCtrInputs = imprRows > 0 && clickRows > 0;
  const hasReportedCtr = mapping.ctr !== undefined;
  const fatigueSignal = hasFrequency || hasCtrInputs || hasReportedCtr;

  const tier: Tier =
    granularity === "snapshot" ? "snapshot"
      : level === "ad" && fatigueSignal ? "full"
        : "trends";

  const hasBudget = mapping.adset_budget !== undefined || mapping.campaign_budget !== undefined
    || mapping.budget !== undefined;
  // A lifetime budget can only be paced against a window if we know how long
  // the flight is; without that the share of budget owed to the window is
  // underivable and pacing is reported as unknown instead of guessed.
  const budgetTypes = [...sampleOf("adset_budget_type", 50), ...sampleOf("campaign_budget_type", 50)];
  const hasLifetime = budgetTypes.some((t) => /life/i.test(t));
  const hasDailyBudget = hasBudget && budgetTypes.length > 0 && budgetTypes.some((t) => !/life/i.test(t));
  const hasFlight = (mapping.starts !== undefined && mapping.ends !== undefined)
    || (mapping.report_start !== undefined && mapping.ends !== undefined)
    || (mapping.report_start !== undefined && mapping.report_end !== undefined);
  // A pacing tracker states its own position in the flight, so pacing needs
  // neither a budget type nor flight dates to be computed.
  const hasTrackerPacing = mapping.budget !== undefined
    && (mapping.days_elapsed !== undefined || mapping.expected_delivered_pct !== undefined);
  const lifetimeWithoutFlight = hasLifetime && !hasFlight;
  if (lifetimeWithoutFlight) {
    warnings.push("The budgets in this file are lifetime budgets but it has no flight start/end columns. Pacing needs them to work out what share of the budget this window should have spent, so pacing is reported as unknown.");
  }

  const capabilities: Capability[] = [
    cap("kpis", "KPI totals", true, "Spend is present."),
    cap("trends", "Daily trends and charts", granularity === "daily",
      granularity === "daily" ? `${sortedDays.length} days of data.` : "No day column, or only one date in the file."),
    cap("period_compare", "Week-over-week comparison", sortedDays.length >= 14,
      sortedDays.length >= 14 ? `${sortedDays.length} days is enough for two full weeks.` : `Needs 14 days; this file has ${sortedDays.length}.`),
    cap("adsets", "Ad set drill-down", level !== "campaign",
      level !== "campaign" ? `${adsetKeys.size} ad sets.` : "No ad set column — re-export with an ad set breakdown."),
    cap("creative_fatigue", "Creative fatigue detection", level === "ad" && granularity === "daily" && fatigueSignal,
      level !== "ad" ? "Needs ad-level rows — re-export at the Ad level."
        : !fatigueSignal ? "Needs frequency, or impressions and clicks to derive CTR."
          : granularity !== "daily" ? "Needs a daily breakdown."
            : "Ad-level rows with a fatigue signal."),
    cap("ctr", "CTR, CPC and CPM", hasCtrInputs || hasReportedCtr,
      hasCtrInputs ? "Recomputed from impressions and clicks."
        : hasReportedCtr ? "Read from the reported CTR column — ratios cannot be re-aggregated exactly."
          : "No impressions or clicks column — these show as not reported, never as 0."),
    cap("roas", "Revenue and ROAS", valueRows > 0,
      valueRows > 0 ? `Conversion value on ${valueRows.toLocaleString()} rows.` : "No conversion value column — ROAS is withheld rather than shown as 0."),
    cap("cpa", "Cost per result", convRows > 0,
      convRows > 0 ? `Results on ${convRows.toLocaleString()} rows.` : "No results or purchases column."),
    cap("frequency", "Frequency and saturation", hasFrequency,
      hasFrequency ? "Frequency column present." : "No frequency column."),
    cap("pacing", "Budget pacing", hasBudget && (hasTrackerPacing || !lifetimeWithoutFlight || hasDailyBudget),
      !hasBudget ? "No budget column — pacing is reported as unknown rather than 0%."
        : hasTrackerPacing
          ? "Budget with days elapsed and days left — pacing is measured against the flight directly."
        : lifetimeWithoutFlight && !hasDailyBudget
          ? "Lifetime budgets need flight start and end dates to pace a window. Map \"Flight start\" and \"Flight end\", or pacing stays unknown."
          : "Budget column present. Lifetime budgets are pro-rated to a daily rate across the flight, so pacing asks whether this window spent its share."),
  ];

  if (valueRows > 0 && valueRows < rows.length) {
    warnings.push(`Conversion value is reported on ${valueRows.toLocaleString()} of ${rows.length.toLocaleString()} rows. ROAS reflects only the rows that carry it.`);
  }
  if (mapping.status === undefined) {
    warnings.push("No delivery-status column. Status is inferred: an entity that recorded spend in this file is treated as Active, one that recorded none as Paused.");
  }
  if (mapping.objective === undefined && mapping.conversions !== undefined) {
    warnings.push("No objective column. The objective is inferred from the results column so \"cost per result\" is labelled correctly.");
  }
  if (mapping.conv_value === undefined && mapping.roas !== undefined) {
    warnings.push("Revenue is derived from the ROAS column multiplied by spend, because the file carries no conversion-value column.");
  }
  if (read.truncated) {
    warnings.push("The file was larger than the row limit and was truncated. Split it by date range and upload each part.");
  }

  // Summed columns are read, so they are not "ignored" and must not be
  // reported as such — the upload panel lists unmapped as what was discarded.
  const claimed = new Set<number>(Object.values(mapping));
  for (const cols of Object.values(additive)) for (const c of cols) claimed.add(c);
  const unmapped = headers.filter((h, i) => !claimed.has(i) && String(h ?? "").trim() !== "");

  const sample = headers.map((h, i) => ({ header: h, values: rows.slice(0, 5).map((r) => String(r[i] ?? "")) }));

  return {
    headers, mapping, additive, unmapped, sheet: read.sheet, sheets: read.sheets,
    level, granularity, tier, currency, dateFormat, numberFormat,
    dateStart: sortedDays[0] ?? null,
    dateEnd: sortedDays[sortedDays.length - 1] ?? null,
    distinctDays: sortedDays.length,
    counts: { rows: rows.length, campaigns: campaignKeys.size, adsets: adsetKeys.size, ads: adKeys.size, skipped },
    totals: {
      spend: round2(spendTotal),
      conversions: convRows ? convTotal : null,
      convValue: valueRows ? round2(valueTotal) : null,
      impressions: imprRows ? imprTotal : null,
      clicks: clickRows ? clickTotal : null,
    },
    capabilities, warnings, errors, sample,
  };
}

/* ═══════════════════════ normalisation ═══════════════════════ */

export interface NormDay {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  convValue: number;
  /** Peak, never a sum — the same people recur across days. */
  reach: number;
  frequency: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  actions: Record<string, number>;
}

export interface NormAd { id: string; name: string; format: string; days: NormDay[] }

export interface NormAdset {
  id: string; name: string; status: string;
  dailyBudget: number; lifetimeBudget: number;
  startTime: string | null; stopTime: string | null;
  optimizationGoal: string; destinationType: string;
  days: NormDay[]; ads: NormAd[];
}

export interface NormCampaign {
  id: string; name: string; status: string; objective: string;
  dailyBudget: number; lifetimeBudget: number;
  startTime: string | null; stopTime: string | null;
  days: NormDay[]; adsets: NormAdset[];
  /**
   * Flight-to-date pacing, present only on a pacing tracker.
   *
   * Such a sheet reports CUMULATIVE spend against a flight budget, plus where
   * in the flight it sits. That cannot be paced the way daily rows are — the
   * generic path compares one window's spend to a pro-rated daily rate and
   * would read a month of cumulative spend as ~2000% over. So the tracker's
   * own basis is carried through and used instead.
   */
  flight?: {
    budget: number;
    daysTotal: number | null;
    daysElapsed: number | null;
    /** The sheet's own verdict, kept for comparison — never used as the answer. */
    reportedStatus: string | null;
  };
}

export interface NormalizedUpload {
  campaigns: NormCampaign[];
  currency: string;
  dateStart: string | null;
  dateEnd: string | null;
  counts: { campaigns: number; adsets: number; ads: number; dayRows: number };
}

/** FNV-1a, so an entity keeps the same id across re-uploads of the same file. */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** URL-safe, stable, and scoped to the batch so two uploads that share a
 *  campaign name cannot overwrite each other's rows. */
function entityId(account: string, kind: "c" | "s" | "a", key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${account}${kind}${slug ? `-${slug}` : ""}-${hash32(key)}`;
}

const emptyDay = (date: string): NormDay => ({
  date, spend: 0, impressions: 0, clicks: 0, conversions: 0, convValue: 0,
  reach: 0, frequency: 0, ctr: 0, cpc: 0, cpm: 0, roas: 0, actions: {},
});

interface Acc {
  days: Map<string, NormDay>;
  /** Reported CTR is averaged only when it is the sole CTR source. */
  ctrSum: Map<string, { sum: number; n: number }>;
  freqSum: Map<string, { sum: number; n: number }>;
  spend: number;
  budget: number | null;
  budgetType: string;
  starts: string | null;
  ends: string | null;
  name: string;
  status: string | null;
  objective: string | null;
  format: string | null;
  flight?: NormCampaign["flight"];
}

const newAcc = (name: string): Acc => ({
  days: new Map(), ctrSum: new Map(), freqSum: new Map(), spend: 0,
  budget: null, budgetType: "", starts: null, ends: null, name,
  status: null, objective: null, format: null,
});

function addDay(acc: Acc, date: string, patch: Partial<NormDay>) {
  const d = acc.days.get(date) ?? emptyDay(date);
  d.spend += patch.spend ?? 0;
  d.impressions += patch.impressions ?? 0;
  d.clicks += patch.clicks ?? 0;
  d.conversions += patch.conversions ?? 0;
  d.convValue += patch.convValue ?? 0;
  // Unique reach cannot be added across rows of the same day either.
  d.reach = Math.max(d.reach, patch.reach ?? 0);
  acc.days.set(date, d);
}

/** Objective implied by which results column the file carries. */
function inferObjective(headers: string[], mapping: Mapping): string {
  if (mapping.conversions === undefined) return "—";
  const h = normalizeHeader(headers[mapping.conversions] ?? "");
  if (/purchase/.test(h)) return "Sales";
  if (/lead/.test(h)) return "Leads";
  if (/click|traffic|landing/.test(h)) return "Traffic";
  if (/engagement|reaction/.test(h)) return "Engagement";
  if (/view|impression|reach/.test(h)) return "Awareness";
  return "—";
}

const mapStatus = (raw: string): string | null => {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^(active|delivering|recently active|in progress)/.test(s)) return "ACTIVE";
  if (/paus/.test(s)) return "PAUSED";
  if (/archiv/.test(s)) return "ARCHIVED";
  if (/delet/.test(s)) return "DELETED";
  if (/review|pending|processing/.test(s)) return "PENDING_REVIEW";
  if (/complet|ended|off/.test(s)) return "PAUSED";
  return null;
};

const avgOf = (v: { sum: number; n: number } | undefined) => (v && v.n ? v.sum / v.n : 0);

/** Finalise per-day derived ratios once every source row has been folded in. */
function finishDays(acc: Acc, hasReportedCtr: boolean): NormDay[] {
  const out: NormDay[] = [];
  const entries = Array.from(acc.days.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [date, d] of entries) {
    // Ratios are recomputed from the day's own totals. Averaging a reported
    // ratio across rows would weight a $2 ad set the same as a $2,000 one.
    d.ctr = d.impressions > 0
      ? round2((d.clicks / d.impressions) * 100)
      : hasReportedCtr
        ? round2(avgOf(acc.ctrSum.get(date)))
        : 0;
    d.cpc = d.clicks > 0 ? round2(d.spend / d.clicks) : 0;
    d.cpm = d.impressions > 0 ? round2((d.spend / d.impressions) * 1000) : 0;
    // Drives ad-set revenue downstream (revenue = sum of roas x spend), so it
    // has to be value divided by spend, never a reported ratio.
    d.roas = d.spend > 0 ? d.convValue / d.spend : 0;
    d.frequency = round2(avgOf(acc.freqSum.get(date)));
    if (d.conversions > 0) d.actions = { purchase: d.conversions };
    out.push(d);
  }
  return out;
}

const minDate = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
const maxDate = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/** Inclusive whole days between two ISO dates; 0 when either is missing. */
function flightLength(from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * The daily budget rate to pace an uploaded window against.
 *
 * An uploaded report covers a window (say 18 days of August), but a lifetime
 * budget covers the whole flight (say January to August). Pacing the window's
 * spend against the whole flight's elapsed expectation compares 18 days of
 * spend with eight months of budget and reports a meaningless few percent.
 *
 * So a lifetime budget is converted to the daily rate it implies across its
 * flight, and pacing then asks the question a pacing report actually asks:
 * did this window spend its share? Without flight dates that share cannot be
 * derived, and 0 is returned so pacing reports "unknown" rather than a number
 * that is wrong.
 */
function dailyRate(budget: number | null, type: string, starts: string | null, ends: string | null): number {
  if (budget === null || budget <= 0) return 0;
  if (!/life/i.test(type)) return budget;
  const days = flightLength(starts, ends);
  return days > 0 ? budget / days : 0;
}

/**
 * Turn analysed rows into the campaign / ad set / ad tree the app stores.
 *
 * Metrics are accumulated independently at each level from the source rows,
 * so a campaign total is the sum of its own rows rather than a re-sum of
 * rounded child figures.
 */
export function normalizeReport(read: ReadResult, analysis: ReportAnalysis, account: string): NormalizedUpload {
  const { rows, headers } = read;
  const { mapping, numberFormat, dateFormat } = analysis;
  const hasReportedCtr = mapping.ctr !== undefined && !(mapping.impressions !== undefined && mapping.clicks !== undefined);
  const dateCol: Field | null =
    mapping.date !== undefined ? "date" : mapping.report_start !== undefined ? "report_start" : null;
  const objectiveFallback = inferObjective(headers, mapping);

  const campaigns = new Map<string, Acc>();
  const adsets = new Map<string, Acc>();
  const ads = new Map<string, Acc>();
  const adsetsOf = new Map<string, Set<string>>();
  const adsOf = new Map<string, Set<string>>();

  const text = (row: string[], f: Field): string => {
    const i = mapping[f];
    return i === undefined ? "" : String(row[i] ?? "").trim();
  };
  const numberAt = (row: string[], f: Field): number | null => {
    const i = mapping[f];
    if (i !== undefined) return parseNumber(row[i], numberFormat);
    // Split across several columns (e.g. revenue by vertical): sum the parts.
    // All-empty stays null, so "not reported" never becomes a measured 0.
    const cols = analysis.additive?.[f];
    if (!cols?.length) return null;
    let total: number | null = null;
    for (const c of cols) {
      const v = parseNumber(row[c], numberFormat);
      if (v !== null) total = (total ?? 0) + v;
    }
    return total;
  };

  // A file with no usable day column still has to produce one dated row, or
  // there is nothing to store. Its own reporting window is the honest label.
  const fallbackDate = analysis.dateStart ?? new Date().toISOString().slice(0, 10);

  for (const row of rows) {
    const campaignKey = text(row, "campaign_id") || text(row, "campaign_name");
    if (!campaignKey) continue;
    const spend = numberAt(row, "spend");
    if (spend === null) continue;

    const date = (dateCol ? parseDate(text(row, dateCol), dateFormat) : null) ?? fallbackDate;

    const impressions = numberAt(row, "impressions") ?? 0;
    const clicks = numberAt(row, "clicks") ?? 0;
    const conversions = numberAt(row, "conversions") ?? 0;
    let convValue = numberAt(row, "conv_value");
    if (convValue === null && mapping.roas !== undefined) {
      const r = numberAt(row, "roas");
      convValue = r === null ? 0 : r * spend;
    }
    const reach = numberAt(row, "reach") ?? 0;
    const frequency = numberAt(row, "frequency");
    const reportedCtr = numberAt(row, "ctr");
    const patch: Partial<NormDay> = { spend, impressions, clicks, conversions, convValue: convValue ?? 0, reach };

    const status = mapStatus(text(row, "status"));
    const objective = text(row, "objective");

    const touch = (acc: Acc) => {
      addDay(acc, date, patch);
      acc.spend += spend;
      if (status && !acc.status) acc.status = status;
      if (frequency !== null) {
        const f = acc.freqSum.get(date) ?? { sum: 0, n: 0 };
        f.sum += frequency; f.n++; acc.freqSum.set(date, f);
      }
      if (reportedCtr !== null) {
        const c = acc.ctrSum.get(date) ?? { sum: 0, n: 0 };
        c.sum += reportedCtr; c.n++; acc.ctrSum.set(date, c);
      }
    };

    // ── campaign ──
    let camp = campaigns.get(campaignKey);
    if (!camp) { camp = newAcc(text(row, "campaign_name") || campaignKey); campaigns.set(campaignKey, camp); }
    touch(camp);
    if (objective && !camp.objective) camp.objective = objective;
    // A pacing tracker's plain "Budget" is the flight budget, so it behaves as
    // a lifetime one; its own flight dates then pro-rate it exactly as any
    // other lifetime budget is. The Ads Manager column wins when both exist.
    const cBudget = numberAt(row, "campaign_budget") ?? numberAt(row, "budget");
    if (cBudget !== null && camp.budget === null) {
      camp.budget = cBudget;
      camp.budgetType = numberAt(row, "campaign_budget") !== null
        ? (text(row, "campaign_budget_type") || "daily")
        : "lifetime";
    }
    // Campaign-level flight dates. Ads Manager exports carry them per ad set
    // and the campaign inherits by roll-up, but a campaign-level tracker has
    // no ad sets to roll up from — without these its budget cannot be paced.
    const trackerBudget = numberAt(row, "budget");
    if (trackerBudget !== null && trackerBudget > 0 && !camp.flight) {
      camp.flight = {
        budget: trackerBudget,
        daysTotal: numberAt(row, "days_total"),
        daysElapsed: numberAt(row, "days_elapsed"),
        reportedStatus: text(row, "pacing_status") || null,
      };
    }
    const cStart = parseDate(text(row, "starts") || text(row, "report_start"), dateFormat);
    const cEnd = parseDate(text(row, "ends") || text(row, "report_end"), dateFormat);
    if (cStart) camp.starts = minDate(camp.starts, cStart);
    if (cEnd) camp.ends = maxDate(camp.ends, cEnd);

    // ── ad set ──
    const adsetKey = text(row, "adset_id") || text(row, "adset_name");
    let setKeyFull = "";
    if (adsetKey) {
      setKeyFull = `${campaignKey} ${adsetKey}`;
      let set = adsets.get(setKeyFull);
      if (!set) { set = newAcc(text(row, "adset_name") || adsetKey); adsets.set(setKeyFull, set); }
      touch(set);
      const sBudget = numberAt(row, "adset_budget");
      if (sBudget !== null && set.budget === null) {
        set.budget = sBudget;
        set.budgetType = text(row, "adset_budget_type") || "daily";
      }
      const s = parseDate(text(row, "starts"), dateFormat);
      const e = parseDate(text(row, "ends"), dateFormat);
      if (s) set.starts = minDate(set.starts, s);
      if (e) set.ends = maxDate(set.ends, e);
      if (!adsetsOf.has(campaignKey)) adsetsOf.set(campaignKey, new Set());
      adsetsOf.get(campaignKey)!.add(setKeyFull);
    }

    // ── ad ──
    const adKey = text(row, "ad_id") || text(row, "ad_name");
    if (adKey && setKeyFull) {
      const adKeyFull = `${setKeyFull} ${adKey}`;
      let ad = ads.get(adKeyFull);
      if (!ad) { ad = newAcc(text(row, "ad_name") || adKey); ads.set(adKeyFull, ad); }
      touch(ad);
      if (!ad.format) ad.format = text(row, "ad_format") || null;
      if (!adsOf.has(setKeyFull)) adsOf.set(setKeyFull, new Set());
      adsOf.get(setKeyFull)!.add(adKeyFull);
    }
  }

  // ── assemble ──
  const inferStatus = (acc: Acc) => acc.status ?? (acc.spend > 0 ? "ACTIVE" : "PAUSED");
  const normFormat = (f: string | null) => {
    const s = String(f ?? "").toLowerCase();
    if (/video|reel/.test(s)) return "Video";
    if (/carousel/.test(s)) return "Carousel";
    return "Image";
  };

  let dayRows = 0;
  let adsetCount = 0;
  let adCount = 0;

  const outCampaigns: NormCampaign[] = [];
  for (const [campaignKey, camp] of Array.from(campaigns.entries())) {
    const setKeys = Array.from(adsetsOf.get(campaignKey) ?? []);
    const outSets: NormAdset[] = [];
    let rolledDaily = 0, rolledLifetime = 0;
    let rolledStart: string | null = null, rolledStop: string | null = null;

    for (const setKeyFull of setKeys) {
      const set = adsets.get(setKeyFull)!;
      const setDays = finishDays(set, hasReportedCtr);
      dayRows += setDays.length;

      // Always stored as a daily rate — see dailyRate above for why a lifetime
      // budget must not be paced against an uploaded window directly.
      const setDaily = dailyRate(set.budget, set.budgetType, set.starts, set.ends);
      const setLifetime = 0;
      rolledDaily += setDaily;
      rolledLifetime += setLifetime;
      rolledStart = minDate(rolledStart, set.starts);
      rolledStop = maxDate(rolledStop, set.ends);

      const outAds: NormAd[] = [];
      for (const adKeyFull of Array.from(adsOf.get(setKeyFull) ?? [])) {
        const ad = ads.get(adKeyFull)!;
        const adDays = finishDays(ad, hasReportedCtr);
        dayRows += adDays.length;
        outAds.push({
          id: entityId(account, "a", adKeyFull),
          name: ad.name,
          format: normFormat(ad.format),
          days: adDays,
        });
      }
      adCount += outAds.length;

      outSets.push({
        id: entityId(account, "s", setKeyFull),
        name: set.name,
        status: inferStatus(set),
        dailyBudget: setDaily,
        lifetimeBudget: setLifetime,
        startTime: set.starts,
        stopTime: set.ends,
        // Left empty on purpose: an uploaded report does not say what an ad
        // set optimised for, and guessing would put a false basis string in
        // front of the user. The campaign objective carries the result ladder.
        optimizationGoal: "",
        destinationType: "",
        days: setDays,
        ads: outAds,
      });
    }
    adsetCount += outSets.length;

    const campDays = finishDays(camp, hasReportedCtr);
    dayRows += campDays.length;

    // A campaign on ad-set budgets carries none of its own; the roll-up is
    // what makes campaign pacing possible at all for those accounts.
    // The campaign's own flight wins where it has one; the roll-up is the
    // fallback for exports that only date their ad sets.
    rolledStart = camp.starts ?? rolledStart;
    rolledStop = camp.ends ?? rolledStop;
    const ownDaily = dailyRate(camp.budget, camp.budgetType, rolledStart, rolledStop);
    const campDaily = ownDaily || rolledDaily;
    const campLifetime = rolledLifetime;

    outCampaigns.push({
      id: entityId(account, "c", campaignKey),
      flight: camp.flight ?? undefined,
      name: camp.name,
      status: inferStatus(camp),
      objective: camp.objective || objectiveFallback,
      dailyBudget: campDaily,
      lifetimeBudget: campLifetime,
      startTime: rolledStart,
      stopTime: rolledStop,
      days: campDays,
      adsets: outSets,
    });
  }

  outCampaigns.sort((a, b) => a.name.localeCompare(b.name));

  return {
    campaigns: outCampaigns,
    currency: analysis.currency,
    dateStart: analysis.dateStart,
    dateEnd: analysis.dateEnd,
    counts: { campaigns: outCampaigns.length, adsets: adsetCount, ads: adCount, dayRows },
  };
}
