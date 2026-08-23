// ── Threshold alerts ────────────────────────────────────────────────
// The cases that matter most are the ones where a rule must NOT fire. An
// account that reports no revenue does not have a 0x ROAS, and an account with
// no impressions does not have a falling CTR — alerting on either would be a
// confident lie about data that was never collected.
//
//   npx tsx tests/alerts.test.mts

import assert from "node:assert/strict";
import type { Campaign } from "../lib/data.js";
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

const { evaluateCampaign, sortAlerts, THRESHOLDS } = await import("../lib/alerts.js");

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: "meta_c1", name: "Test campaign", platform: "meta", status: "Active",
  objective: "Sales", spend: 1000, revenue: 2000, roas: 2, ctr: 1.2, cpc: 1,
  conv: 50, pacing: 100, health: "good", note: "", spark: [],
  ...over,
});

/** n days of identical delivery, with any field overridable per day. */
const series = (n: number, day: Partial<DayPoint> = {}, shape?: (i: number) => Partial<DayPoint>): DayPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    day: `D${i + 1}`, date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    ctr: 0, cpa: 0, spend: 100, revenue: 200,
    impressions: 0, clicks: 0, conversions: 0, reach: 0, frequency: 0,
    ...day, ...(shape ? shape(i) : {}),
  }));

const rules = (as: { rule: string }[]) => as.map((a) => a.rule).sort();

console.log("\nRules that must not fire");
check("no data produces no alerts", () => {
  assert.deepEqual(evaluateCampaign(campaign(), []), []);
});
check("no revenue reported is never a ROAS alert", () => {
  // The whole point: spend with no conversion value means ROAS is unknown,
  // not zero. Firing "below break-even" here would be a false accusation.
  const out = evaluateCampaign(campaign({ revenue: 0 }), series(20, { revenue: 0 }));
  assert.equal(out.filter((a) => /ROAS/.test(a.rule)).length, 0);
});
check("no impressions means no CTR-decline alert", () => {
  // A steadily falling `ctr` field cannot be trusted when the underlying
  // impressions and clicks are absent, so the rule must skip it.
  const out = evaluateCampaign(campaign(), series(10, {}, (i) => ({ ctr: 5 - i })));
  assert.equal(out.filter((a) => /CTR/.test(a.rule)).length, 0);
});
check("sparse revenue attribution is not judged as a ROAS failure", () => {
  // Value on 2 of 18 delivering days reads as ~0.1x, which measures the
  // attribution coverage, not the campaign. Saying "below break-even" from
  // that would be a confident lie.
  const out = evaluateCampaign(campaign(), series(18, { spend: 100, revenue: 0 },
    (i) => (i < 2 ? { revenue: 150 } : {})));
  assert.equal(out.filter((a) => /ROAS/.test(a.rule)).length, 0,
    "ROAS must be withheld until attribution covers most delivering days");
});
check("ROAS is judged once attribution covers most delivering days", () => {
  const out = evaluateCampaign(campaign(), series(18, { spend: 100, revenue: 40 }));
  assert.ok(out.find((a) => a.rule === "ROAS below break-even"),
    "full coverage must still be judged");
});
check("tiny spend is not judged on ratios", () => {
  const out = evaluateCampaign(
    campaign(), series(20, { spend: 1, revenue: 0.1, conversions: 1 }));
  assert.equal(out.filter((a) => /ROAS/.test(a.rule)).length, 0, "below minSpend must not be judged");
});
check("pacing of 0 with no budget is not an underspend alert", () => {
  // `pacing: 0` means "no budget known" elsewhere in the app; it must not be
  // read here as 0% delivery.
  const out = evaluateCampaign(campaign({ pacing: 0, pacingDetail: undefined }), series(20));
  assert.equal(out.filter((a) => /budget/.test(a.rule)).length, 0);
});
check("a paused campaign is not flagged for not delivering", () => {
  const out = evaluateCampaign(campaign({ status: "Paused" }), series(10, { spend: 0, revenue: 0 }));
  assert.equal(out.filter((a) => /delivering/.test(a.rule)).length, 0);
});
check("a healthy campaign raises nothing", () => {
  const out = evaluateCampaign(campaign(), series(30, {
    spend: 100, revenue: 400, impressions: 10_000, clicks: 200, conversions: 10, frequency: 1.5,
  }));
  assert.deepEqual(out, [], `expected silence, got ${JSON.stringify(rules(out))}`);
});

console.log("\nRules that must fire");
check("ROAS below break-even is critical", () => {
  const out = evaluateCampaign(campaign(), series(20, { spend: 100, revenue: 50 }));
  const a = out.find((x) => x.rule === "ROAS below break-even");
  assert.ok(a, `expected a break-even alert, got ${JSON.stringify(rules(out))}`);
  assert.equal(a!.severity, "Critical");
  assert.equal(a!.value, "0.50x");
});
check("thin-but-profitable ROAS is a warning, not critical", () => {
  const out = evaluateCampaign(campaign(), series(20, { spend: 100, revenue: 120 }));
  const a = out.find((x) => x.rule === "ROAS below target");
  assert.ok(a);
  assert.equal(a!.severity, "Warning");
});
check("a sustained CTR decline fires once impressions exist", () => {
  const out = evaluateCampaign(campaign(), series(10, { impressions: 1000, revenue: 400 },
    (i) => ({ clicks: Math.max(1, 40 - i * 4) })));
  const a = out.find((x) => x.rule === "CTR declining");
  assert.ok(a, `expected a CTR alert, got ${JSON.stringify(rules(out))}`);
  assert.equal(a!.severity, "Warning");
});
check("a rising cost per result fires on a 7-vs-7 comparison", () => {
  // First 7 days: 10 conversions/day. Last 7: 4/day on the same spend.
  const out = evaluateCampaign(campaign(), series(14, { spend: 100, revenue: 400, conversions: 10 },
    (i) => (i >= 7 ? { conversions: 4 } : {})));
  const a = out.find((x) => x.rule === "Cost per result rising");
  assert.ok(a, `expected a CPA alert, got ${JSON.stringify(rules(out))}`);
});
check("overspending against a real budget fires", () => {
  const out = evaluateCampaign(campaign({
    pacingDetail: { percent: 180, basis: "daily", expected: 500, spend: 900, budget: 50,
      daysElapsed: 10, totalDays: null, state: "over" },
  }), series(10, { revenue: 400 }));
  const a = out.find((x) => x.rule === "Overspending against budget");
  assert.ok(a);
  assert.equal(a!.value, "180%");
});
check("underspending against a real budget fires", () => {
  const out = evaluateCampaign(campaign({
    pacingDetail: { percent: 40, basis: "lifetime", expected: 2500, spend: 1000, budget: 5000,
      daysElapsed: 10, totalDays: 20, state: "under" },
  }), series(10, { revenue: 400 }));
  assert.ok(out.find((x) => x.rule === "Underspending against budget"));
});
check("saturation fires on peak frequency, not average", () => {
  const out = evaluateCampaign(campaign(), series(10, { revenue: 400, frequency: 2 },
    (i) => (i === 9 ? { frequency: 9.4 } : {})));
  const a = out.find((x) => x.rule === "Audience saturating");
  assert.ok(a, "a single day above the threshold must still be reported");
  assert.equal(a!.value, "9.4");
});
check("an active campaign that stopped delivering is critical", () => {
  const out = evaluateCampaign(campaign(), series(10, { revenue: 400 },
    (i) => (i >= 7 ? { spend: 0, revenue: 0 } : {})));
  const a = out.find((x) => x.rule === "Active but not delivering");
  assert.ok(a);
  assert.equal(a!.severity, "Critical");
});

console.log("\nShape and ordering");
check("every alert carries its campaign, evidence and window", () => {
  const out = evaluateCampaign(campaign(), series(20, { spend: 100, revenue: 50 }));
  for (const a of out) {
    assert.ok(a.id.startsWith("meta_c1:"), "id is namespaced by campaign");
    assert.equal(a.campaignId, "meta_c1");
    assert.equal(a.campaign, "Test campaign");
    assert.equal(a.window, 20, "the window must be visible so thin data is obvious");
    assert.ok(a.detail.length > 20, "every alert states its basis");
    assert.ok(a.value && a.threshold);
  }
});
check("critical outranks warning, then larger spend first", () => {
  const sorted = sortAlerts([
    { id: "a", severity: "Warning", campaignId: "small", campaign: "s", rule: "w1", value: "", threshold: "", detail: "", window: 1 },
    { id: "b", severity: "Critical", campaignId: "small", campaign: "s", rule: "c1", value: "", threshold: "", detail: "", window: 1 },
    { id: "c", severity: "Warning", campaignId: "big", campaign: "b", rule: "w2", value: "", threshold: "", detail: "", window: 1 },
  ], (id) => (id === "big" ? 1000 : 1));
  assert.deepEqual(sorted.map((a) => a.id), ["b", "c", "a"]);
});
check("thresholds are exported so the UI can state them", () => {
  assert.equal(typeof THRESHOLDS.roasCritical, "number");
  assert.ok(THRESHOLDS.roasWarning > THRESHOLDS.roasCritical);
});

console.log(`\n${pass} checks passed.`);
if (process.exitCode) console.log("SOME CHECKS FAILED");
