// ── Budget pacing ───────────────────────────────────────────────────
// Pacing answers "is this spending at the rate its budget implies?", so it is
// always actual spend measured against EXPECTED spend for the elapsed time —
// never last-night's spend over the daily budget, which ignores time entirely
// and reads 0% for any account whose budgets live at ad set level.
//
// Two budget shapes, two denominators:
//   daily budget    → expected = daily_budget × days elapsed in the window
//   lifetime budget → expected = lifetime_budget × (elapsed / total duration)
//
// Used for campaigns and ad sets alike; a campaign on CBO carries the budget
// itself, a campaign on ABO carries none and inherits the sum of its ad sets.

export type PacingBasis = "daily" | "lifetime" | "none";

export interface PacingInput {
  /** Spend actually recorded across the window being displayed. */
  spend: number;
  /** Meta's daily_budget, already converted to major units. 0 when unset. */
  dailyBudget?: number;
  /** Meta's lifetime_budget, already converted to major units. 0 when unset. */
  lifetimeBudget?: number;
  /** Days of delivery the spend covers. Must be ≥ 1 for a daily-budget entity. */
  daysElapsed: number;
  /** Lifetime budgets only: total scheduled days (start_time → stop_time). */
  totalDays?: number;
}

export interface Pacing {
  /** Spend ÷ expected spend, as a percentage. null when no budget is set. */
  percent: number | null;
  basis: PacingBasis;
  /** What we expected to have been spent by now. null without a budget. */
  expected: number | null;
  spend: number;
  budget: number | null;
  daysElapsed: number;
  totalDays: number | null;
  /** Plain-language state a UI can render without re-deriving thresholds. */
  state: "under" | "on-track" | "over" | "unknown";
  /** Why pacing is unknown, when it is — shown instead of a misleading 0%. */
  reason?: string;
}

const UNKNOWN = (spend: number, daysElapsed: number, reason: string): Pacing => ({
  percent: null, basis: "none", expected: null, spend, budget: null,
  daysElapsed, totalDays: null, state: "unknown", reason,
});

/** ±10% around expected is on track; Meta itself routinely over/under-delivers
 *  within that band on any given day. */
export function pacingState(percent: number): Pacing["state"] {
  if (percent < 90) return "under";
  if (percent > 110) return "over";
  return "on-track";
}

export function computePacing(input: PacingInput): Pacing {
  const spend = Math.max(0, input.spend);
  const daysElapsed = Math.max(0, input.daysElapsed);
  const daily = Math.max(0, input.dailyBudget ?? 0);
  const lifetime = Math.max(0, input.lifetimeBudget ?? 0);

  if (lifetime > 0) {
    const totalDays = Math.max(1, input.totalDays ?? 0);
    // Elapsed can exceed the schedule if the campaign ran past its stop time.
    const elapsed = Math.min(Math.max(daysElapsed, 0), totalDays);
    const expected = lifetime * (elapsed / totalDays);
    if (expected <= 0) {
      return { ...UNKNOWN(spend, daysElapsed, "Schedule has not started yet"), basis: "lifetime", budget: lifetime, totalDays };
    }
    const percent = Math.round((spend / expected) * 100);
    return {
      percent, basis: "lifetime", expected: +expected.toFixed(2), spend,
      budget: lifetime, daysElapsed: elapsed, totalDays, state: pacingState(percent),
    };
  }

  if (daily > 0) {
    if (daysElapsed <= 0) {
      return { ...UNKNOWN(spend, daysElapsed, "No delivery days in this window"), basis: "daily", budget: daily };
    }
    const expected = daily * daysElapsed;
    const percent = Math.round((spend / expected) * 100);
    return {
      percent, basis: "daily", expected: +expected.toFixed(2), spend,
      budget: daily, daysElapsed, totalDays: null, state: pacingState(percent),
    };
  }

  // No budget on this object. For a campaign this is normal under ABO — the
  // caller should pass the summed ad set budgets instead of showing 0%.
  return UNKNOWN(spend, daysElapsed, "No budget set on this object");
}

/* ═════════════════ flight-to-date pacing (uploaded trackers) ═════════════════ */

export interface FlightPacing extends Pacing {
  /** Verdict printed in the source sheet, normalised. null when it had none. */
  reported: "under" | "on-track" | "over" | null;
  /** True when the sheet's verdict and the recomputed one disagree. */
  disagrees: boolean;
}

/** "over Pacing", "underpacing", "Even" → the states this app speaks. */
export function normalizeReportedStatus(raw: string | null | undefined): FlightPacing["reported"] {
  const t = String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (t.includes("over")) return "over";
  if (t.includes("under")) return "under";
  if (t.includes("even") || t.includes("ontrack") || t.includes("ontarget")) return "on-track";
  return null;
}

/**
 * Pacing for a campaign whose spend is CUMULATIVE against a flight budget.
 *
 * A pacing tracker states its own position in the flight, so this is the
 * lifetime calculation with the sheet's own elapsed/total rather than dates
 * inferred from daily rows. Passing cumulative spend through the window path
 * instead compares a month of spend to one day of budget and reads ~2000% over.
 *
 * The sheet's own verdict is carried alongside but never substituted for the
 * computed one: a tracker with a stale or broken formula should be caught here,
 * not inherited.
 */
export function flightPacing(input: {
  spend: number;
  budget: number;
  daysTotal: number | null;
  daysElapsed: number | null;
  reportedStatus?: string | null;
}): FlightPacing {
  const reported = normalizeReportedStatus(input.reportedStatus);
  const total = input.daysTotal ?? 0;
  const elapsed = input.daysElapsed ?? 0;

  if (!(input.budget > 0) || !(total > 0) || !(elapsed > 0)) {
    return {
      ...UNKNOWN(input.spend, elapsed, "The tracker did not report a budget and a position in the flight"),
      reported, disagrees: false,
    };
  }

  const base = computePacing({
    spend: input.spend,
    lifetimeBudget: input.budget,
    daysElapsed: elapsed,
    totalDays: total,
  });
  return { ...base, reported, disagrees: reported !== null && reported !== base.state };
}

/** Whole days between two ISO timestamps, inclusive of the start day. */
export function daysBetween(fromISO?: string | null, toISO?: string | null): number {
  if (!fromISO || !toISO) return 0;
  const from = new Date(fromISO).getTime();
  const to = new Date(toISO).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

/** Days elapsed from a start time up to now (capped at a stop time if past). */
export function daysElapsedSince(startISO?: string | null, stopISO?: string | null): number {
  if (!startISO) return 0;
  const start = new Date(startISO).getTime();
  if (!Number.isFinite(start)) return 0;
  const stop = stopISO ? new Date(stopISO).getTime() : NaN;
  const end = Number.isFinite(stop) ? Math.min(Date.now(), stop) : Date.now();
  if (end < start) return 0;
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}
