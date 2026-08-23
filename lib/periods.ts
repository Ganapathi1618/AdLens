// ── Period-over-period comparison ───────────────────────────────────
// Week-over-week and month-over-month, computed from the daily series.
//
// Two correctness rules this module exists to enforce:
//
// 1. Ratios are RECOMPUTED from totals, never averaged. Mean-of-daily-CTR is
//    not the CTR of the period — a day with 10 impressions would count as much
//    as a day with 100,000. CTR is total clicks ÷ total impressions.
// 2. A comparison is only reported when BOTH periods have data. Comparing a
//    full week against two days produces a dramatic, meaningless number, so
//    those cases return `null` and the UI shows nothing rather than a fiction.

import type { DayPoint } from "./datasource";

export interface PeriodTotals {
  days: number;
  spend: number;
  revenue: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number | null;   // %
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
}

export interface MetricChange {
  metric: string;
  current: number | null;
  previous: number | null;
  /** Percentage change. null when it cannot be computed honestly. */
  changePct: number | null;
  /** True when the movement is good for the business (CPA down is good). */
  better: boolean | null;
  /** Lower is better for cost metrics — drives arrow direction in the UI. */
  lowerIsBetter: boolean;
}

export interface PeriodComparison {
  label: "WoW" | "MoM";
  /** Human summary of the windows compared, e.g. "last 7 days vs previous 7". */
  window: string;
  current: PeriodTotals;
  previous: PeriodTotals;
  changes: MetricChange[];
  /** False when there isn't enough history — the UI must then show nothing. */
  comparable: boolean;
  reason?: string;
}

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function totalsFor(days: DayPoint[]): PeriodTotals {
  const spend = days.reduce((t, d) => t + n(d.spend), 0);
  const revenue = days.reduce((t, d) => t + n(d.revenue), 0);
  const impressions = days.reduce((t, d) => t + n(d.impressions), 0);
  const clicks = days.reduce((t, d) => t + n(d.clicks), 0);
  const conversions = days.reduce((t, d) => t + n(d.conversions), 0);

  return {
    days: days.length,
    spend: +spend.toFixed(2),
    revenue: +revenue.toFixed(2),
    impressions,
    clicks,
    conversions,
    // Recomputed from totals — never an average of daily ratios.
    ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : null,
    cpc: clicks > 0 ? +(spend / clicks).toFixed(2) : null,
    cpa: conversions > 0 ? +(spend / conversions).toFixed(2) : null,
    roas: spend > 0 && revenue > 0 ? +(revenue / spend).toFixed(2) : null,
  };
}

export function change(
  metric: string,
  current: number | null,
  previous: number | null,
  lowerIsBetter = false,
): MetricChange {
  let changePct: number | null = null;
  let better: boolean | null = null;

  if (current != null && previous != null && previous !== 0) {
    changePct = +(((current - previous) / Math.abs(previous)) * 100).toFixed(1);
    better = lowerIsBetter ? changePct < 0 : changePct > 0;
    if (changePct === 0) better = null;
  }
  return { metric, current, previous, changePct, better, lowerIsBetter };
}

function compare(
  label: "WoW" | "MoM",
  windowDays: number,
  series: DayPoint[],
): PeriodComparison {
  // Oldest → newest is the contract of getDailySeries.
  const currentDays = series.slice(-windowDays);
  const previousDays = series.slice(-windowDays * 2, -windowDays);

  const current = totalsFor(currentDays);
  const previous = totalsFor(previousDays);
  const window = `last ${windowDays} days vs previous ${windowDays}`;

  // Both windows must be reasonably complete. Half a window against a full one
  // is not a comparison, it is an artefact of when the account was connected.
  const MIN_COVERAGE = 0.6;
  const enough =
    currentDays.length >= windowDays * MIN_COVERAGE &&
    previousDays.length >= windowDays * MIN_COVERAGE;

  if (!enough) {
    return {
      label, window, current, previous, changes: [], comparable: false,
      reason: `Needs ${Math.ceil(windowDays * 2 * MIN_COVERAGE)}+ days of history — have ${series.length}.`,
    };
  }

  return {
    label, window, current, previous, comparable: true,
    changes: [
      change("Spend", current.spend, previous.spend),
      change("Revenue", current.revenue, previous.revenue),
      change("ROAS", current.roas, previous.roas),
      change("CTR", current.ctr, previous.ctr),
      change("CPC", current.cpc, previous.cpc, true),
      change("Conversions", current.conversions, previous.conversions),
      change("Cost per result", current.cpa, previous.cpa, true),
    ],
  };
}

/** Week over week: last 7 days vs the 7 before. */
export const weekOverWeek = (series: DayPoint[]) => compare("WoW", 7, series);

/** Month over month: last 28 days vs the 28 before. 28 rather than 30 so both
 *  windows contain the same number of each weekday — weekday mix is a real
 *  driver of ad performance, and 30-day windows drift against it. */
export const monthOverMonth = (series: DayPoint[]) => compare("MoM", 28, series);

/** Formatted "+12.4%" / "−8.1%", or null when not comparable. */
export function formatChange(c: MetricChange): string | null {
  if (c.changePct == null) return null;
  const sign = c.changePct > 0 ? "+" : c.changePct < 0 ? "−" : "";
  return `${sign}${Math.abs(c.changePct).toFixed(1)}%`;
}
