// ── Shared domain types ─────────────────────────────────────────────
// The shapes every data source produces and every page consumes. There is
// one source of truth for these: whatever the platform actually reported,
// read back out of Postgres. Nothing in this file carries values.
export type Platform = "meta" | "li";
export type Health = "good" | "watch" | "critical" | "paused";

/** Mirrors what Meta actually reports via effective_status. "Archived" and
 *  "Deleted" were previously collapsed into "Paused", which showed archived
 *  campaigns as merely paused. */
export type CampaignStatus = "Active" | "Paused" | "Archived" | "Deleted" | "In Review" | "Incomplete";

export interface Campaign {
  id: string; name: string; platform: Platform; status: CampaignStatus;
  objective: string; spend: number; revenue: number; roas: number; ctr: number;
  cpc: number; conv: number; pacing: number; health: Health; note: string;
  spark: number[];
  /** Full pacing breakdown (basis, expected spend, elapsed days). Present on
   *  live campaigns; `pacing` remains the plain percentage for simple views. */
  pacingDetail?: import("./pacing").Pacing;
  /** Live-only fields. Undefined means "not reported by the platform" —
   *  which is NOT the same as zero and must render as N/A. */
  metaId?: string;          // the raw Meta campaign id, shown in the UI
  impressions?: number;
  reach?: number;           // peak daily unique reach in the window
  frequency?: number;
  cpm?: number;
  cpa?: number;             // undefined when there are no conversions
  conversionValue?: number; // undefined when the account reports no purchase value
  currency?: string;        // ISO code from the ad account
  dateStart?: string;       // actual first synced day (YYYY-MM-DD)
  dateEnd?: string;         // actual last synced day
}
export interface AdSet {
  id: string; campaignId: string; name: string; health: Health; healthLabel: string;
  /** Live only: delivery status and time-aware budget pacing for THIS ad set. */
  status?: CampaignStatus;
  pacing?: number;
  pacingDetail?: import("./pacing").Pacing;
  spend: number; revenue: number; roas: number; ctr: number; cpc: number; freq: number;
  conv: number; reachPct: number; note: string;
  /** Absolute unique people reached (live sources only). reachPct needs a
   *  target-audience denominator the insights API doesn't provide. */
  reachAbs?: number;
  /** Live only: what this ad set optimises for and where it sends people —
   *  these decide what counts as a result. */
  optimizationGoal?: string;
  destinationType?: string;
  /** Every action type this ad set produced, and the result that matches its
   *  own optimisation goal — never the campaign's. */
  actionTotals?: Record<string, number>;
  resultLabel?: string;
  resultBasis?: string;
  results?: number;
  costPerResult?: number | null;
  ctrTrend: number[]; cpaTrend: (number | null)[];
  kpiDeltas: { spend: string; revenue: string; roas: string; ctr: string; cpc: string; freq: string };
  ads: AdItem[];
  insight: { tag: "issue" | "watch" | "rec"; title: string; body: string };
}
export interface AdItem {
  id: string; name: string; format: "Image" | "Video" | "Carousel";
  spend: number; ctr: number; roas: number;
  /** null for objectives where the platform doesn't report reach at ad level (e.g. many Sales campaigns) */
  freq: number | null;
  /** the ad's own first-week CTR — baseline for frequency-free fatigue detection */
  ctrWeek1?: number;
  conv: number;
  action: "Scale" | "Pause" | "Monitor"; rank: "top" | "mid" | "low"; rankLabel: string;
  /** Creative assets — live sources only (Meta creative{...}). */
  thumbnail?: string; title?: string; body?: string; permalink?: string;
}
export interface Recommendation {
  id: string; date: string; title: string; evidence: string; where: string;
  status: "followed" | "ignored" | "pending"; actionDate?: string;
  outcome: string; outcomeDetail: string; outcomeGood?: boolean;
}
export interface AlertRow {
  severity: "Critical" | "Warning"; campaign: string; rule: string;
  value: string; threshold: string; ago: string;
}
