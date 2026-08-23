// ── Month-over-month, on calendar months ────────────────────────────
// lib/periods.ts compares rolling 28-day windows, which is the right tool for
// "is this campaign trending down". A client asks a different question —
// "how did August do against July" — and that needs actual calendar months.
//
// The trap this module exists to handle is the partial month. An export
// covering 1–18 August against a full July shows spend "down 42%", which is a
// fact about the export, not the campaigns. So when the months are not equally
// complete the comparison is aligned to the same day-of-month span in both and
// says so, rather than presenting an artefact as a result.

import { totalsFor, change, type PeriodTotals, type MetricChange } from "./periods";
import type { DayPoint } from "./datasource";

export interface MonthKey {
  /** "2026-08" */
  key: string;
  year: number;
  /** 1-12 */
  month: number;
  /** "August 2026" */
  label: string;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthKey(iso: string): MonthKey | null {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { key: `${m[1]}-${m[2]}`, year, month, label: `${MONTH_NAMES[month - 1]} ${year}` };
}

/** Days in a calendar month, accounting for leap years. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface MonthSummary extends MonthKey {
  /** Days in this month that carry a row. */
  daysWithData: number;
  /** Days the calendar month actually has. */
  daysInMonth: number;
  /** Highest day-of-month present, i.e. how far into the month the data runs. */
  lastDay: number;
  complete: boolean;
  totals: PeriodTotals;
}

const dayOfMonth = (iso: string) => Number(iso.slice(8, 10));

/** Group a daily series into calendar months, newest last. */
export function monthsInSeries(series: DayPoint[]): MonthSummary[] {
  const byMonth = new Map<string, DayPoint[]>();
  for (const d of series) {
    const iso = String(d.date ?? "");
    const k = monthKey(iso);
    if (!k) continue;
    const list = byMonth.get(k.key);
    if (list) list.push(d);
    else byMonth.set(k.key, [d]);
  }

  return Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, days]) => {
      const k = monthKey(`${key}-01`)!;
      const total = daysInMonth(k.year, k.month);
      const lastDay = Math.max(...days.map((d) => dayOfMonth(String(d.date))));
      // Distinct dates, not row count: a portfolio series holds one row per
      // campaign per day, so counting rows would report thousands of "days".
      const distinct = new Set(days.map((d) => String(d.date))).size;
      return {
        ...k,
        daysWithData: distinct,
        daysInMonth: total,
        lastDay,
        // A month is "complete" when data reaches its final day. Gaps inside
        // the month are normal (a campaign simply did not run that day).
        complete: lastDay >= total,
        totals: totalsFor(days),
      };
    });
}

export type Alignment = "full" | "same-days";

export interface MonthComparison {
  current: MonthSummary;
  previous: MonthSummary;
  alignment: Alignment;
  /** When aligned, both months are cut to days 1..alignedTo. */
  alignedTo: number | null;
  changes: MetricChange[];
  /** Present when the numbers cannot be compared honestly at all. */
  blocked?: string;
}

/** Strip the good/bad verdict from a volume metric, keeping the percentage. */
const neutral = (c: MetricChange): MetricChange => ({ ...c, better: null });

/** Cut a month's days to 1..lastDay so two partial months compare like for like. */
function upTo(days: DayPoint[], lastDay: number): DayPoint[] {
  return days.filter((d) => dayOfMonth(String(d.date)) <= lastDay);
}

const daysOf = (series: DayPoint[], key: string) =>
  series.filter((d) => String(d.date ?? "").startsWith(key));

/**
 * Compare two calendar months from one daily series.
 *
 * `alignment` defaults to "auto": full months when both are complete, and the
 * same day-span otherwise. Passing "full" forces raw totals — useful when the
 * caller knows both months are whole, and honest only then.
 */
export function compareMonths(
  series: DayPoint[],
  currentKey: string,
  previousKey: string,
  alignment: Alignment | "auto" = "auto",
): MonthComparison {
  const all = monthsInSeries(series);
  const cur = all.find((m) => m.key === currentKey);
  const prev = all.find((m) => m.key === previousKey);

  const empty = (key: string): MonthSummary => {
    const k = monthKey(`${key}-01`) ?? { key, year: 0, month: 1, label: key };
    return {
      ...k, daysWithData: 0, daysInMonth: daysInMonth(k.year, k.month), lastDay: 0,
      complete: false, totals: totalsFor([]),
    };
  };

  if (!cur || !prev) {
    return {
      current: cur ?? empty(currentKey),
      previous: prev ?? empty(previousKey),
      alignment: "full", alignedTo: null, changes: [],
      blocked: !cur && !prev
        ? "Neither month has any data."
        : `No data for ${(!cur ? monthKey(`${currentKey}-01`) : monthKey(`${previousKey}-01`))?.label ?? "that month"}. Upload a report covering it to compare.`,
    };
  }

  // Two COMPLETE months always compare in full, even though June has 30 days
  // and July 31 — that difference is the calendar, and "how did July do
  // against June" means the whole of each. Truncating there would silently
  // drop the 31st.
  //
  // Alignment is for the other case: a partial month against a longer one,
  // where the gap measures how much data the export contains rather than
  // anything about performance. Two equally partial months need no cut either.
  const bothComplete = cur.complete && prev.complete;
  const ragged = !bothComplete && cur.lastDay !== prev.lastDay;
  const mode: Alignment = alignment === "auto" ? (ragged ? "same-days" : "full") : alignment;

  let curDays = daysOf(series, cur.key);
  let prevDays = daysOf(series, prev.key);
  let alignedTo: number | null = null;

  if (mode === "same-days") {
    alignedTo = Math.min(cur.lastDay, prev.lastDay);
    curDays = upTo(curDays, alignedTo);
    prevDays = upTo(prevDays, alignedTo);
  }

  const c = totalsFor(curDays);
  const p = totalsFor(prevDays);

  return {
    current: { ...cur, totals: c },
    previous: { ...prev, totals: p },
    alignment: mode,
    alignedTo,
    changes: [
      // Volume metrics carry no verdict: spending or serving less is neither
      // good nor bad without knowing what it bought.
      neutral(change("Spend", c.spend, p.spend)),
      change("Revenue", c.revenue, p.revenue),
      change("ROAS", c.roas, p.roas),
      change("Results", c.conversions, p.conversions),
      change("Cost per result", c.cpa, p.cpa, true),
      change("CTR", c.ctr, p.ctr),
      change("CPC", c.cpc, p.cpc, true),
      neutral(change("Impressions", c.impressions, p.impressions)),
    ],
  };
}

/* ═══════════════════════ per-campaign ═══════════════════════ */

export type CampaignTrend = "continuing" | "started" | "stopped";

export interface CampaignMonthDelta {
  id: string;
  name: string;
  trend: CampaignTrend;
  current: PeriodTotals;
  previous: PeriodTotals;
  /** Spend change in currency, the figure that ranks the movers list. */
  spendDelta: number;
  spendChangePct: number | null;
  /** The headline efficiency move: cost per result, or ROAS when tracked. */
  efficiency: MetricChange | null;
}

export interface MonthlyReport {
  currency: string;
  comparison: MonthComparison;
  campaigns: CampaignMonthDelta[];
  /** Biggest efficiency improvements and declines among continuing campaigns. */
  improved: CampaignMonthDelta[];
  declined: CampaignMonthDelta[];
  started: CampaignMonthDelta[];
  stopped: CampaignMonthDelta[];
  /** Every month present in the data, for the picker. */
  available: { key: string; label: string; daysWithData: number; complete: boolean }[];
  /** Things the reader must know before trusting a number. */
  caveats: string[];
}

export interface CampaignSeries {
  id: string;
  name: string;
  series: DayPoint[];
}

/**
 * Build the whole report: portfolio comparison plus a per-campaign breakdown.
 *
 * Campaigns present in only one month are separated out rather than shown as a
 * percentage change — "up 100%" against a month with no data is meaningless,
 * and "started" is the useful fact.
 */
export function buildMonthlyReport(
  campaigns: CampaignSeries[],
  currentKey: string,
  previousKey: string,
  currency: string,
  alignment: Alignment | "auto" = "auto",
): MonthlyReport {
  const portfolioSeries = campaigns.flatMap((c) => c.series);
  const comparison = compareMonths(portfolioSeries, currentKey, previousKey, alignment);
  const available = monthsInSeries(portfolioSeries).map((m) => ({
    key: m.key, label: m.label, daysWithData: m.daysWithData, complete: m.complete,
  }));

  const limit = comparison.alignedTo;
  const monthDays = (series: DayPoint[], key: string) => {
    const days = daysOf(series, key);
    return limit == null ? days : upTo(days, limit);
  };

  const deltas: CampaignMonthDelta[] = campaigns.map((c) => {
    const cur = totalsFor(monthDays(c.series, currentKey));
    const prev = totalsFor(monthDays(c.series, previousKey));
    const ran = (t: PeriodTotals) => t.days > 0 && t.spend > 0;

    const trend: CampaignTrend =
      ran(cur) && ran(prev) ? "continuing" : ran(cur) ? "started" : "stopped";

    // Judge efficiency on ROAS where revenue exists, cost per result otherwise —
    // the same choice the rest of the app makes.
    const revenueTracked = cur.revenue > 0 && prev.revenue > 0;
    const efficiency = trend !== "continuing"
      ? null
      : revenueTracked
        ? change("ROAS", cur.roas, prev.roas)
        : cur.cpa != null || prev.cpa != null
          ? change("Cost per result", cur.cpa, prev.cpa, true)
          : null;

    return {
      id: c.id,
      name: c.name,
      trend,
      current: cur,
      previous: prev,
      spendDelta: +(cur.spend - prev.spend).toFixed(2),
      spendChangePct: prev.spend > 0 ? +(((cur.spend - prev.spend) / prev.spend) * 100).toFixed(1) : null,
      efficiency,
    };
  }).filter((d) => d.current.days > 0 || d.previous.days > 0);

  const continuing = deltas.filter((d) => d.trend === "continuing" && d.efficiency?.changePct != null);
  const byMove = (dir: 1 | -1) =>
    continuing
      .filter((d) => (d.efficiency!.better === (dir === 1)))
      // Rank by money at stake, not by percentage: a 90% swing on $12 is noise.
      .sort((a, b) => Math.max(b.current.spend, b.previous.spend) - Math.max(a.current.spend, a.previous.spend))
      .slice(0, 5);

  const caveats: string[] = [];
  const { current: curM, previous: prevM } = comparison;
  if (comparison.alignment === "same-days" && comparison.alignedTo != null) {
    const longer = curM.lastDay > prevM.lastDay ? curM : prevM;
    caveats.push(
      `Both months are cut to day ${comparison.alignedTo} so they cover the same span. ${longer.label} actually runs to day ${longer.lastDay}; comparing that against day ${Math.min(curM.lastDay, prevM.lastDay)} of the other month would report a difference that is only about how much data each export contains.`);
  } else if (!curM.complete || !prevM.complete) {
    caveats.push(
      `Neither month is complete — both cover days 1 to ${curM.lastDay}. The totals are for that span, not for the whole month.`);
  } else if (curM.daysInMonth !== prevM.daysInMonth) {
    caveats.push(
      `${curM.label} has ${curM.daysInMonth} days and ${prevM.label} has ${prevM.daysInMonth}. Both are compared in full, so part of any change in totals is simply the calendar.`);
  }
  if (comparison.current.totals.revenue === 0 || comparison.previous.totals.revenue === 0) {
    caveats.push("Revenue is not reported in at least one month, so ROAS is withheld and efficiency is judged on cost per result.");
  }
  const startedCount = deltas.filter((d) => d.trend === "started").length;
  const stoppedCount = deltas.filter((d) => d.trend === "stopped").length;
  if (startedCount || stoppedCount) {
    caveats.push(
      `${startedCount} campaign${startedCount === 1 ? "" : "s"} started and ${stoppedCount} stopped between these months. They are listed separately because a percentage change against a month with no delivery is meaningless.`);
  }

  return {
    currency,
    comparison,
    campaigns: deltas.slice().sort((a, b) => Math.abs(b.spendDelta) - Math.abs(a.spendDelta)),
    improved: byMove(1),
    declined: byMove(-1),
    started: deltas.filter((d) => d.trend === "started").sort((a, b) => b.current.spend - a.current.spend),
    stopped: deltas.filter((d) => d.trend === "stopped").sort((a, b) => b.previous.spend - a.previous.spend),
    available,
    caveats,
  };
}

/** The two most recent months present, newest first. Null when there is only one. */
export function defaultMonths(available: { key: string }[]): { current: string; previous: string } | null {
  if (available.length < 2) return null;
  const sorted = available.map((m) => m.key).sort();
  return { current: sorted[sorted.length - 1], previous: sorted[sorted.length - 2] };
}
