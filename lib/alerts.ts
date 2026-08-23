// ── Threshold alerts ────────────────────────────────────────────────
// Rules over the daily metrics already stored for an account. Same discipline
// as lib/reasoning.ts: rules detect, nothing is invented, and a rule that
// depends on a metric the account does not report simply does not fire.
//
// The old alerts page rendered a hardcoded array and told live users "no
// threshold alerts have fired" forever. These are the rules that make that
// sentence mean something.

import type { Campaign } from "./data";
import type { DayPoint } from "./datasource";

export type Severity = "Critical" | "Warning";

export interface Alert {
  id: string;
  severity: Severity;
  campaignId: string;
  campaign: string;
  rule: string;
  /** What was measured. */
  value: string;
  /** What it was measured against. */
  threshold: string;
  /** Plain-language evidence — never a bare number without its basis. */
  detail: string;
  /** Days of data the rule looked at, so a thin window is visible. */
  window: number;
}

/**
 * Rule thresholds.
 *
 * Deliberately conservative and in one place. They are not user-configurable
 * yet; when they become so, this object is the shape to persist per account.
 */
export const THRESHOLDS = {
  /** Below this, spend is not returning its cost. Only applied when the
   *  account actually reports revenue. */
  roasCritical: 1.0,
  roasWarning: 1.5,
  /** Consecutive days of falling CTR before it counts as a decline. */
  ctrFallDays: 3,
  /** Percentage CPA increase, last 7 days vs the 7 before. */
  cpaSpikePct: 30,
  /** Pacing is measured against elapsed time, so these are generous. */
  pacingOver: 130,
  pacingUnder: 60,
  /** Repeat exposure at which creative burn becomes likely. */
  frequency: 7,
  /** A campaign marked active that has not spent for this many days. */
  noDeliveryDays: 3,
  /** Below this spend a campaign's ratios are too noisy to judge. */
  minSpend: 50,
  /**
   * Share of delivering days that must carry a conversion value before ROAS is
   * judged at all.
   *
   * Exports routinely attribute revenue on a minority of rows. A campaign with
   * value on 2 of 18 delivering days reads as 0.1x ROAS, which is an artefact
   * of attribution coverage, not a verdict on the campaign — and "below
   * break-even" is far too confident a thing to say from it. Below this share
   * the ROAS rules are skipped, in the same spirit as never treating a missing
   * column as a zero.
   */
  revenueCoverage: 0.5,
} as const;

const pct = (now: number, then: number) => (then === 0 ? 0 : Math.round(((now - then) / then) * 100));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Consecutive falls at the end of a series. */
function consecutiveFalls(trend: number[]): number {
  let falls = 0;
  for (let i = trend.length - 1; i > 0; i--) {
    if (trend[i] < trend[i - 1]) falls++;
    else break;
  }
  return falls;
}

/**
 * Evaluate every rule for one campaign.
 *
 * `series` must already be limited to the window being reported on. An empty
 * series produces no alerts rather than a "zero everything" alarm.
 */
export function evaluateCampaign(campaign: Campaign, series: DayPoint[]): Alert[] {
  const out: Alert[] = [];
  const days = series.length;
  if (!days) return out;

  const spend = sum(series.map((d) => d.spend));
  const revenue = sum(series.map((d) => d.revenue));
  const conversions = sum(series.map((d) => d.conversions ?? 0));
  const impressions = sum(series.map((d) => d.impressions ?? 0));
  const clicks = sum(series.map((d) => d.clicks ?? 0));

  const add = (a: Omit<Alert, "id" | "campaignId" | "campaign" | "window">) =>
    out.push({
      ...a,
      id: `${campaign.id}:${a.rule}`,
      campaignId: campaign.id,
      campaign: campaign.name,
      window: days,
    });

  // Ratios below this spend are noise, not signal.
  const judgeable = spend >= THRESHOLDS.minSpend;

  // ── revenue efficiency ──────────────────────────────────────────
  // Gated on the account reporting revenue at all: an account with no purchase
  // tracking has no ROAS, and reporting 0x as failure would be a false alarm.
  const deliveringDays = series.filter((d) => d.spend > 0).length;
  const daysWithRevenue = series.filter((d) => d.revenue > 0).length;
  const revenueCoverage = deliveringDays > 0 ? daysWithRevenue / deliveringDays : 0;

  if (judgeable && revenue > 0 && revenueCoverage >= THRESHOLDS.revenueCoverage) {
    const roas = revenue / spend;
    if (roas < THRESHOLDS.roasCritical) {
      add({
        severity: "Critical", rule: "ROAS below break-even",
        value: `${roas.toFixed(2)}x`, threshold: `${THRESHOLDS.roasCritical.toFixed(1)}x`,
        detail: `Returned less than it cost over ${days} days: spend and reported value are ${roas.toFixed(2)}x apart.`,
      });
    } else if (roas < THRESHOLDS.roasWarning) {
      add({
        severity: "Warning", rule: "ROAS below target",
        value: `${roas.toFixed(2)}x`, threshold: `${THRESHOLDS.roasWarning.toFixed(1)}x`,
        detail: `Profitable but thin across ${days} days of delivery.`,
      });
    }
  }

  // ── engagement decline ──────────────────────────────────────────
  // Needs impressions and clicks; an account without them has no CTR, and no
  // rule here will pretend otherwise.
  if (impressions > 0 && clicks > 0) {
    const ctrTrend = series
      .filter((d) => (d.impressions ?? 0) > 0)
      .map((d) => +(((d.clicks ?? 0) / (d.impressions ?? 1)) * 100).toFixed(3));
    const falls = consecutiveFalls(ctrTrend);
    if (falls >= THRESHOLDS.ctrFallDays) {
      add({
        severity: "Warning", rule: "CTR declining",
        value: `${falls} days`, threshold: `${THRESHOLDS.ctrFallDays} days`,
        detail: `CTR fell every day for ${falls} days (${ctrTrend[ctrTrend.length - 1 - falls]?.toFixed(2)}% to ${ctrTrend[ctrTrend.length - 1].toFixed(2)}%).`,
      });
    }
  }

  // ── cost per result ─────────────────────────────────────────────
  if (judgeable && days >= 14 && conversions > 0) {
    const last7 = series.slice(-7);
    const prev7 = series.slice(-14, -7);
    const cpa = (window: DayPoint[]) => {
      const c = sum(window.map((d) => d.conversions ?? 0));
      return c > 0 ? sum(window.map((d) => d.spend)) / c : null;
    };
    const now = cpa(last7);
    const before = cpa(prev7);
    if (now !== null && before !== null) {
      const change = pct(now, before);
      if (change >= THRESHOLDS.cpaSpikePct) {
        add({
          severity: change >= THRESHOLDS.cpaSpikePct * 2 ? "Critical" : "Warning",
          rule: "Cost per result rising",
          value: `+${change}%`, threshold: `+${THRESHOLDS.cpaSpikePct}%`,
          detail: `Cost per result moved from ${before.toFixed(2)} to ${now.toFixed(2)} comparing the last 7 days with the 7 before.`,
        });
      }
    }
  }

  // ── pacing ──────────────────────────────────────────────────────
  // Only from a real computed pacing figure; `pacing: 0` means "no budget
  // known" elsewhere in the app and must not read as 0% delivery here.
  const pacing = campaign.pacingDetail;
  if (pacing?.percent != null && pacing.basis !== "none") {
    if (pacing.percent > THRESHOLDS.pacingOver) {
      add({
        severity: "Warning", rule: "Overspending against budget",
        value: `${pacing.percent}%`, threshold: `${THRESHOLDS.pacingOver}%`,
        detail: `Spent ${pacing.spend.toFixed(0)} against ${pacing.expected?.toFixed(0) ?? "?"} expected for the elapsed ${pacing.daysElapsed} days.`,
      });
    } else if (pacing.percent < THRESHOLDS.pacingUnder) {
      add({
        severity: "Warning", rule: "Underspending against budget",
        value: `${pacing.percent}%`, threshold: `${THRESHOLDS.pacingUnder}%`,
        detail: `Spent ${pacing.spend.toFixed(0)} against ${pacing.expected?.toFixed(0) ?? "?"} expected for the elapsed ${pacing.daysElapsed} days — budget is going unused.`,
      });
    }
  }

  // ── saturation ──────────────────────────────────────────────────
  const freqDays = series.map((d) => d.frequency ?? 0).filter((f) => f > 0);
  if (freqDays.length) {
    const peak = Math.max(...freqDays);
    if (peak > THRESHOLDS.frequency) {
      add({
        severity: "Warning", rule: "Audience saturating",
        value: peak.toFixed(1), threshold: String(THRESHOLDS.frequency),
        detail: `Peak daily frequency of ${peak.toFixed(1)} means the same people are seeing this repeatedly.`,
      });
    }
  }

  // ── delivery ────────────────────────────────────────────────────
  if (campaign.status === "Active" && days >= THRESHOLDS.noDeliveryDays) {
    const tail = series.slice(-THRESHOLDS.noDeliveryDays);
    if (tail.every((d) => d.spend === 0)) {
      add({
        severity: "Critical", rule: "Active but not delivering",
        value: `${THRESHOLDS.noDeliveryDays} days`, threshold: "any spend",
        detail: `Marked Active but recorded no spend on the last ${THRESHOLDS.noDeliveryDays} days in this data.`,
      });
    }
  }

  return out;
}

/** Most urgent first, then largest spend, so the list opens on what matters. */
export function sortAlerts(alerts: Alert[], spendOf: (id: string) => number): Alert[] {
  return alerts.slice().sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "Critical" ? -1 : 1;
    return spendOf(b.campaignId) - spendOf(a.campaignId);
  });
}
