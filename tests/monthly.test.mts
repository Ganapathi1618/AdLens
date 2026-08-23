// ── Month-over-month on calendar months ─────────────────────────────
// The partial month is the whole reason this module exists. An 18-day August
// against a full July is "spend down 42%" only in the sense that the export is
// shorter — these checks pin the difference between a result and an artefact.
//
//   npx tsx tests/monthly.test.mts

import assert from "node:assert/strict";
import type { DayPoint } from "../lib/datasource.js";

let pass = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    console.log(`  FAIL  ${label}\n        ${(e as Error).message}`);
    process.exitCode = 1;
  }
};

const {
  monthKey, daysInMonth, monthsInSeries, compareMonths, buildMonthlyReport, defaultMonths,
} = await import("../lib/monthly.js");

/** Days `from`..`to` of one month, each carrying the same metrics. */
const month = (ym: string, from: number, to: number, day: Partial<DayPoint> = {}): DayPoint[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    day: `${ym}-${String(from + i).padStart(2, "0")}`,
    date: `${ym}-${String(from + i).padStart(2, "0")}`,
    ctr: 0, cpa: 0, spend: 100, revenue: 200,
    impressions: 0, clicks: 0, conversions: 10, reach: 0, frequency: 0,
    ...day,
  }));

const metric = (changes: { metric: string }[], name: string) => changes.find((c) => c.metric === name)!;

console.log("\nMonth keys");
check("an ISO date resolves to its month", () => {
  const k = monthKey("2026-08-19")!;
  assert.equal(k.key, "2026-08");
  assert.equal(k.label, "August 2026");
});
check("an invalid month is rejected", () => {
  assert.equal(monthKey("2026-13-01"), null);
  assert.equal(monthKey("nonsense"), null);
});
check("February knows about leap years", () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2026, 8), 31);
});

console.log("\nGrouping");
check("days group into calendar months", () => {
  const months = monthsInSeries([...month("2026-07", 1, 31), ...month("2026-08", 1, 18)]);
  assert.deepEqual(months.map((m) => m.key), ["2026-07", "2026-08"]);
  assert.equal(months[0].complete, true, "a July running to the 31st is complete");
  assert.equal(months[1].complete, false, "an August stopping at the 18th is not");
  assert.equal(months[1].lastDay, 18);
});
check("a portfolio series counts distinct dates, not rows", () => {
  // One row per campaign per day: three campaigns over 18 days is 54 rows but
  // still 18 days. Counting rows reported thousands of "days".
  const series = [...month("2026-08", 1, 18), ...month("2026-08", 1, 18), ...month("2026-08", 1, 18)];
  assert.equal(monthsInSeries(series)[0].daysWithData, 18);
});

console.log("\nPartial months");
check("ragged months are cut to the same day span", () => {
  const series = [...month("2026-07", 1, 31), ...month("2026-08", 1, 18)];
  const c = compareMonths(series, "2026-08", "2026-07");
  assert.equal(c.alignment, "same-days");
  assert.equal(c.alignedTo, 18);
  // Identical daily spend, so a like-for-like comparison must be flat. Raw
  // totals would report 1800 vs 3100 — a 42% "drop" that never happened.
  assert.equal(c.current.totals.spend, 1800);
  assert.equal(c.previous.totals.spend, 1800);
  assert.equal(metric(c.changes, "Spend").changePct, 0);
});
check("two equally partial months are not truncated", () => {
  const series = [...month("2026-07", 1, 18), ...month("2026-08", 1, 18)];
  const c = compareMonths(series, "2026-08", "2026-07");
  assert.equal(c.alignment, "full", "nothing to align when both run to the same day");
  assert.equal(c.alignedTo, null);
});
check("two complete months compare in full", () => {
  const series = [...month("2026-06", 1, 30), ...month("2026-07", 1, 31)];
  const c = compareMonths(series, "2026-07", "2026-06");
  assert.equal(c.alignment, "full");
  assert.equal(c.current.totals.spend, 3100);
  assert.equal(c.previous.totals.spend, 3000);
});
check("alignment can be forced off", () => {
  const series = [...month("2026-07", 1, 31), ...month("2026-08", 1, 18)];
  const c = compareMonths(series, "2026-08", "2026-07", "full");
  assert.equal(c.current.totals.spend, 1800);
  assert.equal(c.previous.totals.spend, 3100);
});
check("a missing month blocks rather than comparing against nothing", () => {
  const c = compareMonths(month("2026-08", 1, 18), "2026-08", "2026-07");
  assert.ok(c.blocked, "must refuse instead of reporting an infinite increase");
  assert.match(c.blocked!, /July 2026/);
  assert.deepEqual(c.changes, []);
});

console.log("\nVerdicts");
check("spending less is not reported as worse", () => {
  // Volume is not quality. Telling a client that spending less is "worse" —
  // with no reference to what it bought — is a wrong verdict, not a nuance.
  const series = [...month("2026-07", 1, 30, { spend: 200 }), ...month("2026-08", 1, 30, { spend: 100 })];
  const c = compareMonths(series, "2026-08", "2026-07");
  const spend = metric(c.changes, "Spend");
  assert.ok(spend.changePct! < 0, "the percentage is still reported");
  assert.equal(spend.better, null, "but carries no good/bad verdict");
  assert.equal(metric(c.changes, "Impressions").better, null);
});
check("cost per result falling is better, ROAS falling is worse", () => {
  const series = [
    ...month("2026-07", 1, 30, { spend: 200, conversions: 10, revenue: 400 }),
    ...month("2026-08", 1, 30, { spend: 100, conversions: 10, revenue: 100 }),
  ];
  const c = compareMonths(series, "2026-08", "2026-07");
  assert.equal(metric(c.changes, "Cost per result").better, true);
  assert.equal(metric(c.changes, "ROAS").better, false);
});
check("metrics absent from the data stay null", () => {
  const series = [...month("2026-07", 1, 30), ...month("2026-08", 1, 30)];
  const c = compareMonths(series, "2026-08", "2026-07");
  assert.equal(metric(c.changes, "CTR").current, null, "no impressions means no CTR");
  assert.equal(metric(c.changes, "CPC").current, null);
});

console.log("\nPer-campaign report");
const twoMonths = (id: string, name: string, julSpend: number, augSpend: number, extra: Partial<DayPoint> = {}) => ({
  id, name,
  series: [
    ...month("2026-07", 1, 30, { spend: julSpend, ...extra }),
    ...month("2026-08", 1, 30, { spend: augSpend, ...extra }),
  ],
});

check("campaigns are classified as continuing, started or stopped", () => {
  const rep = buildMonthlyReport([
    twoMonths("meta_a", "Both months", 100, 120),
    { id: "meta_b", name: "New in August", series: month("2026-08", 1, 30) },
    { id: "meta_c", name: "Ended in July", series: month("2026-07", 1, 30) },
  ], "2026-08", "2026-07", "USD");

  assert.equal(rep.campaigns.find((c) => c.id === "meta_a")!.trend, "continuing");
  assert.deepEqual(rep.started.map((c) => c.name), ["New in August"]);
  assert.deepEqual(rep.stopped.map((c) => c.name), ["Ended in July"]);
});
check("a campaign that only ran in one month gets no percentage change", () => {
  const rep = buildMonthlyReport(
    [{ id: "meta_b", name: "New", series: month("2026-08", 1, 30) }],
    "2026-08", "2026-07", "USD");
  const started = rep.started[0];
  assert.equal(started.spendChangePct, null, "no baseline means no percentage");
  assert.equal(started.efficiency, null, "and no efficiency verdict");
});
check("movers rank by money at stake, not by percentage", () => {
  // A 50% efficiency swing on $10 must not outrank a 20% swing on $10,000.
  const rep = buildMonthlyReport([
    { id: "meta_small", name: "Tiny", series: [
      ...month("2026-07", 1, 30, { spend: 1, conversions: 10, revenue: 0 }),
      ...month("2026-08", 1, 30, { spend: 1, conversions: 20, revenue: 0 }),
    ] },
    { id: "meta_big", name: "Large", series: [
      ...month("2026-07", 1, 30, { spend: 500, conversions: 10, revenue: 0 }),
      ...month("2026-08", 1, 30, { spend: 500, conversions: 12, revenue: 0 }),
    ] },
  ], "2026-08", "2026-07", "USD");
  assert.equal(rep.improved[0].name, "Large", "the big spender leads the movers list");
});
check("the report discloses truncation and missing revenue", () => {
  const rep = buildMonthlyReport(
    [{ id: "meta_a", name: "A", series: [...month("2026-07", 1, 31), ...month("2026-08", 1, 18, { revenue: 0 })] }],
    "2026-08", "2026-07", "USD");
  assert.ok(rep.caveats.some((c) => /same span/.test(c)), "truncation must be stated");
  assert.ok(rep.caveats.some((c) => /Revenue is not reported/.test(c)));
});
check("every month present is offered for the picker", () => {
  const rep = buildMonthlyReport(
    [{ id: "meta_a", name: "A", series: [...month("2026-06", 1, 30), ...month("2026-07", 1, 31), ...month("2026-08", 1, 18)] }],
    "2026-08", "2026-07", "USD");
  assert.deepEqual(rep.available.map((m) => m.key), ["2026-06", "2026-07", "2026-08"]);
});
check("the default pair is the two most recent months", () => {
  const d = defaultMonths([{ key: "2026-06" }, { key: "2026-08" }, { key: "2026-07" }])!;
  assert.equal(d.current, "2026-08");
  assert.equal(d.previous, "2026-07");
});
check("one month alone offers no default pair", () => {
  assert.equal(defaultMonths([{ key: "2026-08" }]), null);
});

console.log(`\n${pass} checks passed.`);
if (process.exitCode) console.log("SOME CHECKS FAILED");
