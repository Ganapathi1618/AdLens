// ── Pacing trackers ─────────────────────────────────────────────────
// An agency paces flights in a purpose-built sheet, not in Ads Manager. Those
// sheets report CUMULATIVE spend against a flight budget and state their own
// position in the flight, which the daily-rows path cannot pace: it compares a
// month of spend to one day of expectation and reads ~2000% over.
//
//   npx tsx tests/pacing-tracker.test.mts
//   TEST_DATABASE_URL=postgres://... npx tsx tests/pacing-tracker.test.mts

import assert from "node:assert/strict";

let pass = 0;
const check = (label: string, fn: () => void | Promise<void>) => {
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => { pass++; console.log(`  PASS  ${label}`); },
      (e) => { console.log(`  FAIL  ${label}\n        ${e.message}`); process.exitCode = 1; });
    pass++; console.log(`  PASS  ${label}`);
  } catch (e) {
    console.log(`  FAIL  ${label}\n        ${(e as Error).message}`);
    process.exitCode = 1;
  }
  return Promise.resolve();
};

const { readReport, analyzeReport, normalizeReport, detectMapping, detectAdditiveColumns } =
  await import("../lib/adsReport.js");
const { flightPacing, normalizeReportedStatus } = await import("../lib/pacing.js");

const toBuf = (rows: string[][]) =>
  Buffer.from(rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c}"` : c)).join(",")).join("\n") + "\n", "utf8");

// A tracker in the shape agencies actually keep: run-together headers, a
// cumulative spend column, the flight position, and revenue split by vertical.
const HEADER = [
  "Campaign Name", "Reporting starts", "Ends", "Total Days", "Days elapsed", "Days Left",
  "Budget", "Actualspent", "ExpectedDelivered%", "ActualDelivered%", "BudgetLeft",
  "RequiredDailyNeeded", "Yesterday'sspent", "OverallPacing", "Pacing Status",
  "Tickets Purchases", "Tickets Purchase Value", "Birthday Purchases", "Birthday Purchase Value",
];
const row = (name: string, budget: string, spent: string, pacing: string, status: string) =>
  [name, "2026-08-01", "2026-08-31", "31", "20", "11", budget, spent, "0.65", "0.70",
   "100", "9.09", "10.5", pacing, status, "3", "300", "1", "150"];

console.log("\nColumn vocabulary");
await check("\"Actualspent\" is recognised as spend", () => {
  assert.equal(detectMapping(HEADER).spend, 7);
});
await check("the flight position columns map", () => {
  const m = detectMapping(HEADER);
  assert.equal(m.budget, 6);
  assert.equal(m.days_total, 3);
  assert.equal(m.days_elapsed, 4);
  assert.equal(m.days_left, 5);
  assert.equal(m.pacing_status, 14);
});
await check("an Ads Manager spend column still wins over the tracker's", () => {
  const both = ["Campaign name", "Amount spent (USD)", "Actualspent"];
  assert.equal(detectMapping(both).spend, 1);
});
await check("revenue split across verticals is summed, not dropped", () => {
  const m = detectMapping(HEADER);
  const add = detectAdditiveColumns(HEADER, m);
  assert.deepEqual(add.conv_value, [16, 18], "both purchase-value columns");
  assert.deepEqual(add.conversions, [15, 17], "both purchase-count columns");
});
await check("a lone part is not treated as a total", () => {
  const one = ["Campaign name", "Amount spent", "Tickets Purchase Value"];
  assert.equal(detectAdditiveColumns(one, detectMapping(one)).conv_value, undefined);
});
await check("a real total is preferred over the parts", () => {
  const mixed = [...HEADER, "Purchases conversion value"];
  const m = detectMapping(mixed);
  assert.equal(m.conv_value, mixed.length - 1);
  assert.equal(detectAdditiveColumns(mixed, m).conv_value, undefined, "no double counting");
});

console.log("\nParsing a tracker");
const read = readReport(toBuf([HEADER, row("Alpha", "3000", "2000", "1.03", "Even")]), "tracker.csv");
const analysis = analyzeReport(read);
await check("it parses without a spend error", () => assert.deepEqual(analysis.errors, []));
await check("pacing is reported as available", () => {
  assert.equal(analysis.capabilities.find((c) => c.key === "pacing")?.available, true);
});
await check("summed revenue reaches the totals", () => {
  assert.equal(analysis.totals.convValue, 450, "300 + 150");
  assert.equal(analysis.totals.conversions, 4, "3 + 1");
});
await check("summed columns are not reported as ignored", () => {
  for (const h of ["Tickets Purchase Value", "Birthday Purchase Value"]) {
    assert.ok(!analysis.unmapped.includes(h), `${h} should be read, not discarded`);
  }
});
await check("the flight travels into the normalized campaign", () => {
  const norm = normalizeReport(read, analysis, "up000000000000");
  const f = norm.campaigns[0].flight;
  assert.equal(f?.budget, 3000);
  assert.equal(f?.daysTotal, 31);
  assert.equal(f?.daysElapsed, 20);
  assert.equal(f?.reportedStatus, "Even");
});

console.log("\nRecomputing the verdict");
await check("cumulative spend paces against the flight, not the window", () => {
  // 20 of 31 days elapsed on a 3000 budget → 1935.48 expected. 2000 spent.
  const p = flightPacing({ spend: 2000, budget: 3000, daysTotal: 31, daysElapsed: 20, reportedStatus: "Even" });
  assert.equal(p.percent, 103);
  assert.equal(p.state, "on-track");
  assert.ok(p.percent! < 200, "must not read as thousands of percent");
});
await check("under-delivery is caught", () => {
  const p = flightPacing({ spend: 1000, budget: 3000, daysTotal: 31, daysElapsed: 20 });
  assert.equal(p.state, "under");
});
await check("over-delivery is caught", () => {
  const p = flightPacing({ spend: 3000, budget: 3000, daysTotal: 31, daysElapsed: 20 });
  assert.equal(p.state, "over");
});
await check("a disagreement with the sheet is flagged, not inherited", () => {
  const p = flightPacing({ spend: 1000, budget: 3000, daysTotal: 31, daysElapsed: 20, reportedStatus: "Even" });
  assert.equal(p.state, "under");
  assert.equal(p.reported, "on-track");
  assert.equal(p.disagrees, true);
});
await check("agreement is not flagged", () => {
  const p = flightPacing({ spend: 2000, budget: 3000, daysTotal: 31, daysElapsed: 20, reportedStatus: "Even" });
  assert.equal(p.disagrees, false);
});
await check("the sheet's wording is understood", () => {
  assert.equal(normalizeReportedStatus("over Pacing"), "over");
  assert.equal(normalizeReportedStatus("underpacing"), "under");
  assert.equal(normalizeReportedStatus("Even"), "on-track");
  assert.equal(normalizeReportedStatus(""), null);
  assert.equal(normalizeReportedStatus("something else"), null);
});
await check("a tracker with no flight position reports unknown, never 0%", () => {
  const p = flightPacing({ spend: 2000, budget: 3000, daysTotal: null, daysElapsed: null });
  assert.equal(p.state, "unknown");
  assert.equal(p.percent, null);
  assert.ok(p.reason);
});

/* ═══════════ persistence, through the live readers ═══════════ */

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log(`\n${pass} checks passed. TEST_DATABASE_URL not set — skipping the persistence half.`);
} else {
  process.env.DATABASE_URL = url;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url });
  const tagged = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.reduce((a, s, i) => a + s + (i < vals.length ? `$${i + 1}` : ""), "");
    return (await pool.query(text, vals as never[])).rows;
  };
  const db = await import("../lib/db.js");
  db.__setSqlForTests(tagged as never);
  await pool.query(`DROP TABLE IF EXISTS meta_ad_daily, meta_ads, meta_adset_daily,
    meta_adsets, meta_daily_metrics, meta_campaigns, sync_log, upload_batches CASCADE`);

  const uploads = await import("../lib/uploads.js");
  const meta = await import("../lib/meta.js");
  const { buildEvidence } = await import("../lib/reasoning.js");

  const rows = [HEADER,
    row("OnPlan", "3000", "2000", "1.03", "Even"),
    row("Behind", "3000", "1000", "0.52", "underpacing"),
    row("Ahead", "3000", "2900", "1.50", "over Pacing"),
    row("SheetWrong", "3000", "1000", "1.00", "Even"),
  ];
  const r2 = readReport(toBuf(rows), "tracker.csv");
  const a2 = analyzeReport(r2);
  const account = uploads.newUploadAccountId();
  await uploads.ensureUploadSchema();
  await uploads.commitUpload({
    account, label: "Tracker", filename: "tracker.csv", sheet: null, timezone: "UTC",
    level: a2.level, granularity: a2.granularity, tier: a2.tier,
    distinctDays: a2.distinctDays, rowsParsed: a2.counts.rows,
    capabilities: a2.capabilities, warnings: a2.warnings,
    mapping: a2.mapping, unmapped: a2.unmapped,
    data: normalizeReport(r2, a2, account),
  });
  meta.setActiveAccount(account);

  console.log("\nPersistence");
  await check("the flight survives the round trip and paces correctly", async () => {
    const camps = await meta.loadLiveCampaigns();
    const by = (n: string) => camps.find((c) => c.name === n)!;
    assert.equal(by("OnPlan").pacingDetail?.state, "on-track");
    assert.equal(by("Behind").pacingDetail?.state, "under");
    assert.equal(by("Ahead").pacingDetail?.state, "over");
  });
  await check("a sheet whose own verdict is wrong is contradicted, not echoed", async () => {
    const c = (await meta.loadLiveCampaigns()).find((x) => x.name === "SheetWrong")!;
    const p = c.pacingDetail as { state: string; reported?: string; disagrees?: boolean };
    assert.equal(p.state, "under", "1000 of 3000 at 20/31 days is behind");
    assert.equal(p.reported, "on-track", "the sheet claimed Even");
    assert.equal(p.disagrees, true);
  });
  await check("cumulative spend never reads as thousands of percent", async () => {
    for (const c of await meta.loadLiveCampaigns()) {
      assert.ok((c.pacingDetail?.percent ?? 0) < 300, `${c.name} paced ${c.pacingDetail?.percent}%`);
    }
  });
  await check("the evidence pack carries what the report needs", async () => {
    const c = (await meta.loadLiveCampaigns()).find((x) => x.name === "Behind")!;
    const ev = await buildEvidence(c.id);
    const p = ev!.pacing!;
    assert.equal(p.state, "under");
    assert.equal(p.budget, 3000);
    assert.ok(p.gap! < 0, "behind on spend");
    assert.ok(p.requiredDaily! > 0, "must say what to spend per remaining day");
    // 2000 left over 11 remaining days
    assert.equal(p.requiredDaily, 181.82);
  });
  await check("revenue split by vertical reaches the campaign", async () => {
    const c = (await meta.loadLiveCampaigns()).find((x) => x.name === "OnPlan")!;
    assert.equal(c.revenue, 450, "300 + 150 summed, not one column or none");
    assert.equal(c.conv, 4);
  });

  await pool.end();
  console.log(`\n${pass} checks passed.`);
}
