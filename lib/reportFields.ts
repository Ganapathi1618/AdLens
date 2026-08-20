// ── Report field vocabulary ─────────────────────────────────────────
// Client-safe: pure types and labels, no parser and no database imports.
//
// The upload UI renders the mapping table and the capability list from these,
// and lib/adsReport.ts produces them. They live apart because importing the
// parser into a client component would pull node:zlib (the .xlsx reader) into
// the browser bundle, which cannot resolve it.

// lib/csv.ts is pure string handling with no Node imports, so these types are
// safe to reach for from a client component.
import type { DateFormat, NumberFormat } from "./csv";

export type Field =
  | "date" | "campaign_id" | "campaign_name" | "adset_id" | "adset_name"
  | "ad_id" | "ad_name" | "spend" | "impressions" | "clicks" | "reach"
  | "frequency" | "ctr" | "cpc" | "cpm" | "conversions" | "conv_value" | "roas"
  | "objective" | "status" | "currency" | "ad_format"
  | "campaign_budget" | "campaign_budget_type" | "adset_budget" | "adset_budget_type"
  | "starts" | "ends" | "report_start" | "report_end";

export interface FieldSpec {
  key: Field;
  label: string;
  kind: "text" | "number" | "date";
  /** Without these the upload cannot be committed at all. */
  required?: boolean;
  help: string;
}

export const FIELD_SPECS: FieldSpec[] = [
  { key: "date", label: "Day", kind: "date", help: "One row per day. Without it there are no trends — only a single snapshot." },
  { key: "campaign_name", label: "Campaign name", kind: "text", required: true, help: "Groups rows into campaigns." },
  { key: "campaign_id", label: "Campaign ID", kind: "text", help: "Preferred over the name for grouping when present." },
  { key: "adset_name", label: "Ad set name", kind: "text", help: "Enables the ad set drill-down." },
  { key: "adset_id", label: "Ad set ID", kind: "text", help: "Preferred over the name for grouping when present." },
  { key: "ad_name", label: "Ad name", kind: "text", help: "Required for creative fatigue detection." },
  { key: "ad_id", label: "Ad ID", kind: "text", help: "Preferred over the name for grouping when present." },
  { key: "ad_format", label: "Ad format", kind: "text", help: "Image / Video / Carousel." },
  { key: "spend", label: "Amount spent", kind: "number", required: true, help: "The one metric every analysis needs." },
  { key: "impressions", label: "Impressions", kind: "number", help: "With clicks, gives CTR and CPM." },
  { key: "clicks", label: "Link clicks", kind: "number", help: "With impressions, gives CTR and CPC." },
  { key: "ctr", label: "CTR", kind: "number", help: "Used only when impressions and clicks are absent — a reported ratio cannot be re-aggregated exactly." },
  { key: "cpc", label: "CPC", kind: "number", help: "Recomputed from spend divided by clicks when both are present." },
  { key: "cpm", label: "CPM", kind: "number", help: "Recomputed from spend and impressions when both are present." },
  { key: "reach", label: "Reach", kind: "number", help: "Unique people. Never summed across days." },
  { key: "frequency", label: "Frequency", kind: "number", help: "The strongest creative-fatigue signal." },
  { key: "conversions", label: "Results / Purchases", kind: "number", help: "Drives cost per result." },
  { key: "conv_value", label: "Conversion value", kind: "number", help: "Purchase value. Without it there is no ROAS." },
  { key: "roas", label: "ROAS", kind: "number", help: "Used only to derive value when conversion value is absent." },
  { key: "objective", label: "Objective", kind: "text", help: "Decides what counts as a result." },
  { key: "status", label: "Delivery status", kind: "text", help: "Active / Paused. Inferred from spend when absent." },
  { key: "currency", label: "Currency", kind: "text", help: "ISO code. Also read from a header like \"Amount spent (USD)\"." },
  { key: "campaign_budget", label: "Campaign budget", kind: "number", help: "Enables campaign pacing." },
  { key: "campaign_budget_type", label: "Campaign budget type", kind: "text", help: "Daily or Lifetime." },
  { key: "adset_budget", label: "Ad set budget", kind: "number", help: "Enables ad set pacing, and campaign pacing by roll-up." },
  { key: "adset_budget_type", label: "Ad set budget type", kind: "text", help: "Daily or Lifetime." },
  { key: "starts", label: "Flight start", kind: "date", help: "Needed to pace a lifetime budget." },
  { key: "ends", label: "Flight end", kind: "date", help: "Needed to pace a lifetime budget." },
  { key: "report_start", label: "Reporting starts", kind: "date", help: "Used as the day column when there is no explicit one." },
  { key: "report_end", label: "Reporting ends", kind: "date", help: "Report window end." },
];

export const FIELD_BY_KEY: Record<Field, FieldSpec> =
  Object.fromEntries(FIELD_SPECS.map((f) => [f.key, f])) as Record<Field, FieldSpec>;

export type Mapping = Partial<Record<Field, number>>;

export interface SheetChoice { name: string; rows: number; columns: number }

export type Level = "ad" | "adset" | "campaign";
export type Granularity = "daily" | "snapshot";
export type Tier = "full" | "trends" | "snapshot";

export interface Capability {
  key: string;
  label: string;
  available: boolean;
  reason: string;
}

export interface ReportAnalysis {
  headers: string[];
  mapping: Mapping;
  unmapped: string[];
  sheet: string | null;
  sheets: SheetChoice[];
  level: Level;
  granularity: Granularity;
  tier: Tier;
  currency: string;
  dateFormat: DateFormat;
  numberFormat: NumberFormat;
  dateStart: string | null;
  dateEnd: string | null;
  distinctDays: number;
  counts: { rows: number; campaigns: number; adsets: number; ads: number; skipped: number };
  totals: { spend: number; conversions: number | null; convValue: number | null; impressions: number | null; clicks: number | null };
  capabilities: Capability[];
  warnings: string[];
  errors: string[];
  sample: { header: string; values: string[] }[];
}

export const TIER_LABEL: Record<Tier, string> = {
  full: "Full analysis",
  trends: "Trends only",
  snapshot: "Snapshot only",
};

export const TIER_BLURB: Record<Tier, string> = {
  full: "Ad-level rows with a daily breakdown — every part of AdLens works, including creative fatigue detection.",
  trends: "Daily rows, but no ad-level detail or fatigue signal — you get KPIs, trends and period comparison, not creative diagnosis.",
  snapshot: "One row per entity with no daily breakdown — KPI totals only. No trends, no comparison, no recommendations.",
};
