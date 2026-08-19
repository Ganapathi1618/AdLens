// ── Uploaded reports, end to end ────────────────────────────────────
// Parsing and mapping are pure and always run. The persistence half runs only
// with TEST_DATABASE_URL set, and it is the half that matters most: it proves
// an uploaded file comes back out through the SAME readers the Graph API sync
// feeds, with the same totals it went in with.
//
//   npx tsx tests/upload.test.mts
//   TEST_DATABASE_URL=postgres://... npx tsx tests/upload.test.mts

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

/* ═══════════ 1. delimited parsing and coercion ═══════════ */

const { parseDelimited, parseNumber, parseDate, detectDateFormat, detectNumberFormat, sniffDelimiter } =
  await import("../lib/csv.js");

console.log("\nCSV parsing");
await check("quoted field containing the delimiter", () => {
  const { rows } = parseDelimited(`a,b\n"Summer Sale, Broad",10\n`);
  assert.deepEqual(rows[1], ["Summer Sale, Broad", "10"]);
});
await check("escaped quotes inside a quoted field", () => {
  const { rows } = parseDelimited(`a\n"He said ""hi"""\n`);
  assert.deepEqual(rows[1], ['He said "hi"']);
});
await check("embedded newline inside a quoted field", () => {
  const { rows } = parseDelimited(`a,b\n"line1\nline2",7\n`);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ["line1\nline2", "7"]);
});
await check("CRLF line endings and a UTF-8 BOM", () => {
  const { rows } = parseDelimited(`﻿a,b\r\n1,2\r\n`);
  assert.deepEqual(rows[0], ["a", "b"]);
  assert.deepEqual(rows[1], ["1", "2"]);
});
await check("delimiter sniffed from the header, not from quoted commas", () => {
  assert.equal(sniffDelimiter(`name\tspend\n"a,b,c,d,e"\t1`), "\t");
});
await check("trailing newline does not become a blank row", () => {
  assert.equal(parseDelimited("a,b\n1,2\n").rows.length, 2);
});

console.log("\nNumber coercion");
await check("thousands separators", () => assert.equal(parseNumber("1,234.56"), 1234.56));
await check("currency symbol and spaces", () => assert.equal(parseNumber("₹ 1,234"), 1234));
await check("European format when the column votes for it", () => {
  const fmt = detectNumberFormat(["1.234,56", "2.999,10"]);
  assert.equal(fmt, "eu");
  assert.equal(parseNumber("1.234,56", fmt), 1234.56);
});
await check("US format is the default for an ambiguous column", () => {
  assert.equal(detectNumberFormat(["1,234"]), "us");
});
await check("empty and placeholder cells are null, never 0", () => {
  for (const v of ["", "—", "-", "N/A", "n/a", null, undefined]) {
    assert.equal(parseNumber(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});
await check("a real zero stays zero", () => assert.equal(parseNumber("0"), 0));
await check("text in a numeric column is null", () => {
  assert.equal(parseNumber("Using ad set budget"), null);
});
await check("parenthesised negatives", () => assert.equal(parseNumber("(1,234)"), -1234));
await check("percentages drop the sign", () => assert.equal(parseNumber("1.42%"), 1.42));

console.log("\nDate coercion");
await check("ISO dates", () => assert.equal(parseDate("2026-08-01"), "2026-08-01"));
await check("day-first proven by a component above 12", () => {
  const { format, ambiguous } = detectDateFormat(["13/02/2026", "01/02/2026"]);
  assert.equal(format, "dmy");
  assert.equal(ambiguous, false);
  assert.equal(parseDate("01/02/2026", format), "2026-02-01");
});
await check("month-first proven by a component above 12", () => {
  const { format } = detectDateFormat(["02/13/2026", "01/02/2026"]);
  assert.equal(format, "mdy");
  assert.equal(parseDate("01/02/2026", format), "2026-01-02");
});
await check("a genuinely ambiguous column is flagged", () => {
  assert.equal(detectDateFormat(["01/02/2026", "03/04/2026"]).ambiguous, true);
});
await check("a proving component overrides the column verdict", () => {
  // 25 cannot be a month whatever the rest of the column looked like.
  assert.equal(parseDate("25/12/2026", "mdy"), "2026-12-25");
});
await check("textual month names", () => {
  assert.equal(parseDate("Aug 1, 2026", "text"), "2026-08-01");
  assert.equal(parseDate("1 August 2026", "text"), "2026-08-01");
});
await check("impossible dates are rejected, not rolled forward", () => {
  assert.equal(parseDate("2026-02-31"), null);
  assert.equal(parseDate("31/04/2026", "dmy"), null);
});

/* ═══════════ 2. xlsx ═══════════ */

const { serialToISO, isDateFormatCode } = await import("../lib/xlsx.js");
console.log("\nXLSX helpers");
await check("Excel serial 45888 is 2025-08-19", () => assert.equal(serialToISO(45888), "2025-08-19"));
await check("the 1900 leap-year bug is handled either side of the boundary", () => {
  assert.equal(serialToISO(59), "1900-02-28");
  assert.equal(serialToISO(61), "1900-03-01");
});
await check("date format codes are told apart from number ones", () => {
  assert.equal(isDateFormatCode("yyyy\\-mm\\-dd"), true);
  assert.equal(isDateFormatCode("#,##0.00"), false);
  assert.equal(isDateFormatCode('"Total: "#,##0'), false);
});

/* ═══════════ 3. mapping and tiering ═══════════ */

const { detectMapping, analyzeReport, normalizeReport, readReport } = await import("../lib/adsReport.js");

const toBuf = (rows: string[][]) =>
  Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n"), "utf8");

console.log("\nColumn mapping");
await check("the exact spend column wins over a looser one", () => {
  const m = detectMapping(["Campaign name", "Amount spent (USD)", "Total Spent (USD)"]);
  assert.equal(m.spend, 1, "should map 'Amount spent', not 'Total Spent'");
});
await check("conversion value is not swallowed by the conversion count", () => {
  const m = detectMapping(["Purchases", "Purchases conversion value"]);
  assert.equal(m.conversions, 0);
  assert.equal(m.conv_value, 1);
});
await check("flight dates are not confused with the reporting window", () => {
  const m = detectMapping(["Starts", "Ends", "Reporting starts", "Reporting ends"]);
  assert.equal(m.starts, 0);
  assert.equal(m.ends, 1);
  assert.equal(m.report_start, 2);
  assert.equal(m.report_end, 3);
});
await check("currency is read from the spend header", () => {
  const r = readReport(toBuf([["Campaign name", "Amount spent (INR)"], ["A", "10"]]), "a.csv");
  assert.equal(analyzeReport(r).currency, "INR");
});
await check("a title block above the header is skipped", () => {
  const r = readReport(toBuf([
    ["Urban Air — Monthly Pacing"], ["Generated 2026-08-19"], [],
    ["Campaign name", "Day", "Amount spent (USD)"],
    ["A", "2026-08-01", "10"],
  ]), "a.csv");
  assert.deepEqual(r.headers, ["Campaign name", "Day", "Amount spent (USD)"]);
  assert.equal(r.rows.length, 1);
});

console.log("\nCapability tiering");
const tierOf = (rows: string[][]) => analyzeReport(readReport(toBuf(rows), "a.csv"));

await check("campaign level with one date is a snapshot", () => {
  const a = tierOf([["Campaign name", "Day", "Amount spent"], ["A", "2026-08-01", "10"]]);
  assert.equal(a.tier, "snapshot");
  assert.equal(a.capabilities.find((c) => c.key === "trends")?.available, false);
});
await check("daily ad-set rows are 'trends only', not 'full'", () => {
  const a = tierOf([
    ["Campaign name", "Ad set name", "Day", "Amount spent"],
    ["A", "S1", "2026-08-01", "10"], ["A", "S1", "2026-08-02", "12"],
  ]);
  assert.equal(a.tier, "trends");
  assert.equal(a.level, "adset");
  assert.equal(a.capabilities.find((c) => c.key === "creative_fatigue")?.available, false);
});
await check("ad-level rows with frequency are 'full'", () => {
  const a = tierOf([
    ["Campaign name", "Ad set name", "Ad name", "Day", "Amount spent", "Frequency"],
    ["A", "S1", "Ad1", "2026-08-01", "10", "2.1"],
    ["A", "S1", "Ad1", "2026-08-02", "12", "2.4"],
  ]);
  assert.equal(a.tier, "full");
  assert.equal(a.capabilities.find((c) => c.key === "creative_fatigue")?.available, true);
});
await check("ad-level rows with NO fatigue signal are not 'full'", () => {
  const a = tierOf([
    ["Campaign name", "Ad set name", "Ad name", "Day", "Amount spent"],
    ["A", "S1", "Ad1", "2026-08-01", "10"], ["A", "S1", "Ad1", "2026-08-02", "12"],
  ]);
  assert.equal(a.tier, "trends");
});
await check("a missing spend column is a blocking error", () => {
  const a = tierOf([["Campaign name", "Day"], ["A", "2026-08-01"]]);
  assert.ok(a.errors.some((e) => /spend/i.test(e)), "should refuse without spend");
});
await check("no impressions means CTR is unavailable, not zero", () => {
  const a = tierOf([["Campaign name", "Day", "Amount spent"], ["A", "2026-08-01", "10"], ["A", "2026-08-02", "9"]]);
  const ctr = a.capabilities.find((c) => c.key === "ctr");
  assert.equal(ctr?.available, false);
  assert.match(ctr?.reason ?? "", /never as 0/);
});

console.log("\nNormalisation");
await check("ratios are recomputed from totals, never averaged", () => {
  // Two ad sets on one day: 1 click/1000 impr and 99 clicks/1000 impr.
  // The true blended CTR is 5.00%, the average of the two rows is also 5.00,
  // so use uneven impressions to tell them apart: 100 and 1900 impressions.
  const rows = [
    ["Campaign name", "Ad set name", "Day", "Amount spent", "Impressions", "Link clicks"],
    ["A", "S1", "2026-08-01", "10", "100", "10"],   // 10%
    ["A", "S2", "2026-08-01", "10", "1900", "10"],  // 0.53%
  ];
  const read = readReport(toBuf(rows), "a.csv");
  const n = normalizeReport(read, analyzeReport(read), "up000000000000");
  const day = n.campaigns[0].days[0];
  // Blended = 20 / 2000 = 1.00%. A naive average of the rows would be 5.26%.
  assert.equal(day.ctr, 1);
});
await check("ad-set revenue reconstructs exactly from roas x spend", () => {
  const rows = [
    ["Campaign name", "Ad set name", "Day", "Amount spent", "Purchases conversion value"],
    ["A", "S1", "2026-08-01", "40", "100"],
    ["A", "S1", "2026-08-02", "60", "230"],
  ];
  const read = readReport(toBuf(rows), "a.csv");
  const n = normalizeReport(read, analyzeReport(read), "up000000000000");
  const set = n.campaigns[0].adsets[0];
  const revenue = set.days.reduce((s, d) => s + d.roas * d.spend, 0);
  assert.equal(Math.round(revenue * 100) / 100, 330);
});
await check("reach is a peak, not a sum", () => {
  const rows = [
    ["Campaign name", "Ad set name", "Day", "Amount spent", "Reach"],
    ["A", "S1", "2026-08-01", "10", "500"],
    ["A", "S2", "2026-08-01", "10", "700"],
  ];
  const read = readReport(toBuf(rows), "a.csv");
  const n = normalizeReport(read, analyzeReport(read), "up000000000000");
  assert.equal(n.campaigns[0].days[0].reach, 700);
});
await check("lifetime budgets are pro-rated across the flight and rolled up", () => {
  // Pacing an 18-day window against an eight-month lifetime expectation reports
  // a meaningless few percent, so a lifetime budget is stored as the daily rate
  // it implies. S1: 1000 over 243 days. S2: 2500 over 242 days.
  const rows = [
    ["Campaign name", "Ad set name", "Day", "Amount spent", "Campaign Budget", "Ad Set Budget", "Ad Set Budget Type", "Starts", "Ends"],
    ["A", "S1", "2026-08-01", "10", "Using ad set budget", "1000", "Lifetime", "2026-01-01", "2026-08-31"],
    ["A", "S2", "2026-08-01", "10", "Using ad set budget", "2500", "Lifetime", "2026-02-01", "2026-09-30"],
  ];
  const read = readReport(toBuf(rows), "a.csv");
  const n = normalizeReport(read, analyzeReport(read), "up000000000000");
  const c = n.campaigns[0];
  const s1 = c.adsets.find((a) => a.name === "S1")!;
  const s2 = c.adsets.find((a) => a.name === "S2")!;
  assert.equal(Math.round(s1.dailyBudget * 1e4) / 1e4, Math.round((1000 / 243) * 1e4) / 1e4);
  assert.equal(Math.round(s2.dailyBudget * 1e4) / 1e4, Math.round((2500 / 242) * 1e4) / 1e4);
  assert.equal(s1.lifetimeBudget, 0, "the lifetime figure is consumed by the pro-rate");
  assert.equal(Math.round(c.dailyBudget * 1e4) / 1e4,
    Math.round((1000 / 243 + 2500 / 242) * 1e4) / 1e4,
    "campaign rate is the sum of its ad sets' rates");
  assert.equal(c.startTime, "2026-01-01");
  assert.equal(c.stopTime, "2026-09-30");
});
await check("a lifetime budget with no flight dates leaves pacing unknown", () => {
  // Without the flight length the window's share of the budget is underivable.
  // Reporting no budget is correct; inventing a percentage is not.
  const rows = [
    ["Campaign name", "Ad set name", "Day", "Amount spent", "Ad Set Budget", "Ad Set Budget Type"],
    ["A", "S1", "2026-08-01", "10", "1000", "Lifetime"],
  ];
  const read = readReport(toBuf(rows), "a.csv");
  const a = analyzeReport(read);
  const n = normalizeReport(read, a, "up000000000000");
  assert.equal(n.campaigns[0].adsets[0].dailyBudget, 0);
  assert.equal(n.campaigns[0].adsets[0].lifetimeBudget, 0);
  assert.equal(a.capabilities.find((c) => c.key === "pacing")?.available, false);
  assert.ok(a.warnings.some((w) => /flight start/i.test(w)), "the limitation must be disclosed");
});
await check("an explicit daily budget passes through untouched", () => {
  const rows = [
    ["Campaign name", "Ad set name", "Day", "Amount spent", "Ad Set Budget", "Ad Set Budget Type"],
    ["A", "S1", "2026-08-01", "10", "50", "Daily"],
  ];
  const read = readReport(toBuf(rows), "a.csv");
  const n = normalizeReport(read, analyzeReport(read), "up000000000000");
  assert.equal(n.campaigns[0].adsets[0].dailyBudget, 50);
});
await check("status is inferred from spend when the column is absent", () => {
  const rows = [
    ["Campaign name", "Day", "Amount spent"],
    ["Spending", "2026-08-01", "10"],
    ["Idle", "2026-08-01", "0"],
  ];
  const read = readReport(toBuf(rows), "a.csv");
  const a = analyzeReport(read);
  const n = normalizeReport(read, a, "up000000000000");
  assert.equal(n.campaigns.find((c) => c.name === "Spending")?.status, "ACTIVE");
  assert.equal(n.campaigns.find((c) => c.name === "Idle")?.status, "PAUSED");
  assert.ok(a.warnings.some((w) => /inferred/i.test(w)), "the inference must be disclosed");
});
await check("entity ids are stable across re-parses and scoped to the batch", () => {
  const rows = [["Campaign name", "Day", "Amount spent"], ["A", "2026-08-01", "10"]];
  const read = readReport(toBuf(rows), "a.csv");
  const a = analyzeReport(read);
  const one = normalizeReport(read, a, "up000000000000").campaigns[0].id;
  const two = normalizeReport(read, a, "up000000000000").campaigns[0].id;
  const other = normalizeReport(read, a, "up111111111111").campaigns[0].id;
  assert.equal(one, two, "same batch, same file → same id");
  assert.notEqual(one, other, "a different batch must not collide");
});

/* ═══════════ 4. persistence, through the live readers ═══════════ */

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

  console.log("\nPersistence");
  await check("the schema bootstraps on a database that has never synced Meta", async () => {
    await uploads.ensureUploadSchema();
    const t = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN
       ('meta_campaigns','meta_daily_metrics','meta_adsets','meta_adset_daily','meta_ads','meta_ad_daily','upload_batches')`);
    assert.equal(t.rowCount, 7, "every table should be created from scratch");
  });

  // A small but complete fixture: two campaigns, ad sets, ads, two days.
  const fixture = [
    ["Campaign name", "Ad set name", "Ad name", "Day", "Amount spent (EUR)", "Impressions", "Link clicks", "Purchases", "Purchases conversion value", "Frequency", "Reach", "Ad Set Budget", "Ad Set Budget Type", "Starts", "Ends"],
    ["Alpha", "A-Set", "A-Ad", "2026-08-01", "100", "10000", "200", "4", "400", "1.5", "6000", "3000", "Lifetime", "2026-08-01", "2026-08-31"],
    ["Alpha", "A-Set", "A-Ad", "2026-08-02", "150", "12000", "180", "5", "600", "1.8", "7000", "3000", "Lifetime", "2026-08-01", "2026-08-31"],
    ["Beta", "B-Set", "B-Ad", "2026-08-01", "50", "4000", "40", "1", "90", "1.1", "3500", "1000", "Lifetime", "2026-08-01", "2026-08-31"],
    ["Beta", "B-Set", "B-Ad", "2026-08-02", "70", "5000", "35", "0", "", "1.3", "4000", "1000", "Lifetime", "2026-08-01", "2026-08-31"],
  ];
  const read = readReport(toBuf(fixture), "fixture.csv");
  const analysis = analyzeReport(read);
  const account = uploads.newUploadAccountId();

  await check("commit writes the whole tree", async () => {
    const data = normalizeReport(read, analysis, account);
    const batch = await uploads.commitUpload({
      account, label: "Fixture", filename: "fixture.csv", sheet: null, timezone: "Europe/Berlin",
      level: analysis.level, granularity: analysis.granularity, tier: analysis.tier,
      distinctDays: analysis.distinctDays, rowsParsed: analysis.counts.rows,
      capabilities: analysis.capabilities, warnings: analysis.warnings,
      mapping: analysis.mapping, unmapped: analysis.unmapped, data,
    });
    assert.equal(batch.campaigns, 2);
    assert.equal(batch.adsets, 2);
    assert.equal(batch.ads, 2);
    assert.equal(batch.currency, "EUR");
    assert.equal(batch.tier, "full");
  });

  meta.setActiveAccount(account);

  await check("campaigns read back through loadLiveCampaigns with correct totals", async () => {
    const list = await meta.loadLiveCampaigns();
    assert.equal(list.length, 2);
    const alpha = list.find((c) => c.name === "Alpha")!;
    assert.equal(alpha.spend, 250);
    assert.equal(alpha.revenue, 1000, "revenue is the reported conversion value");
    assert.equal(alpha.roas, 4);
    // 380 clicks / 22000 impressions = 1.7272… → 1.73
    assert.equal(alpha.ctr, 1.73);
    assert.equal(alpha.conv, 9);
    assert.equal(alpha.currency, "EUR", "currency comes from the batch, not META_CURRENCY");
    assert.equal(alpha.note, "Uploaded report", "provenance must survive the round trip");
  });

  await check("a campaign with no conversion value reports no ROAS rather than 0x", async () => {
    const beta = (await meta.loadLiveCampaigns()).find((c) => c.name === "Beta")!;
    assert.equal(beta.spend, 120);
    assert.equal(beta.revenue, 90);
    assert.equal(beta.conv, 1);
  });

  await check("campaign pacing measures the window against its share of the budget", async () => {
    // 3000 lifetime over a 31-day flight = 96.77/day. Two delivered days in the
    // file, so the window is owed 193.55 and actually spent 250 → 129%, over.
    const alpha = (await meta.loadLiveCampaigns()).find((c) => c.name === "Alpha")!;
    assert.equal(alpha.pacingDetail?.basis, "daily", "lifetime budgets are pro-rated to a daily rate");
    assert.equal(Math.round((alpha.pacingDetail?.budget ?? 0) * 100) / 100, 96.77);
    assert.equal(alpha.pacingDetail?.expected, 193.55);
    assert.equal(alpha.pacingDetail?.percent, 129);
    assert.equal(alpha.pacingDetail?.state, "over");
  });

  const alphaId = (await meta.loadLiveCampaigns()).find((c) => c.name === "Alpha")!.id;

  await check("the daily series reads back day by day", async () => {
    const series = await meta.loadLiveSeries(alphaId);
    assert.equal(series.length, 2);
    assert.equal(series[0].date, "2026-08-01");
    assert.equal(series[0].spend, 100);
    assert.equal(series[0].revenue, 400);
    assert.equal(series[1].spend, 150);
  });

  await check("the series honours a date filter", async () => {
    const series = await meta.loadLiveSeries(alphaId, "2026-08-02", "2026-08-02");
    assert.equal(series.length, 1);
    assert.equal(series[0].date, "2026-08-02");
  });

  await check("ad sets and their ads read back with the ad-level detail intact", async () => {
    const sets = await meta.loadLiveAdsets(alphaId);
    assert.equal(sets.length, 1);
    const set = sets[0];
    assert.equal(set.name, "A-Set");
    assert.equal(set.spend, 250);
    assert.equal(set.revenue, 1000, "ad set revenue is rebuilt from roas x spend");
    assert.equal(set.ads.length, 1);
    assert.equal(set.ads[0].name, "A-Ad");
    // loadLiveAdsets rounds ad frequency to one decimal: (1.5 + 1.8) / 2 = 1.65 -> 1.6
    assert.equal(set.ads[0].freq, 1.6, "frequency is averaged across the window");
    assert.equal(set.results, 9, "the actions map drives results");
  });

  await check("ad-set pacing works from the ad set's own budget", async () => {
    const set = (await meta.loadLiveAdsets(alphaId))[0];
    assert.equal(set.pacingDetail?.basis, "daily");
    assert.equal(Math.round((set.pacingDetail?.budget ?? 0) * 100) / 100, 96.77);
    assert.equal(set.pacingDetail?.percent, 129);
  });

  await check("the account identity resolves with no Meta credential at all", async () => {
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_AD_ACCOUNT_ID;
    meta.setActiveAccount(account);
    const info = await meta.fetchAccountInfo(true);
    assert.equal(info?.name, "Fixture");
    assert.equal(info?.currency, "EUR");
    assert.equal(info?.timezone, "Europe/Berlin");
  });

  await check("a campaign id alone resolves its own account", async () => {
    meta.setActiveAccount(null);
    // This is what /api/db/campaign-detail does with no account parameter.
    const c = await meta.loadLiveCampaign(alphaId);
    assert.ok(c, "the campaign must be found without an explicit account");
    assert.equal(c!.name, "Alpha");
  });

  await check("re-committing replaces rather than doubling the totals", async () => {
    meta.setActiveAccount(account);
    const data = normalizeReport(read, analysis, account);
    await uploads.commitUpload({
      account, label: "Fixture v2", filename: "fixture.csv", sheet: null, timezone: "Europe/Berlin",
      level: analysis.level, granularity: analysis.granularity, tier: analysis.tier,
      distinctDays: analysis.distinctDays, rowsParsed: analysis.counts.rows,
      capabilities: analysis.capabilities, warnings: analysis.warnings,
      mapping: analysis.mapping, unmapped: analysis.unmapped, data,
    });
    const alpha = (await meta.loadLiveCampaigns()).find((c) => c.name === "Alpha")!;
    assert.equal(alpha.spend, 250, "totals must not double on re-upload");
    assert.equal((await uploads.listBatches()).length, 1, "re-commit keeps one batch");
  });

  await check("two batches stay isolated from each other", async () => {
    const second = uploads.newUploadAccountId();
    const data2 = normalizeReport(read, analyzeReport(read), second);
    await uploads.commitUpload({
      account: second, label: "Second", filename: "fixture.csv", sheet: null, timezone: "UTC",
      level: analysis.level, granularity: analysis.granularity, tier: analysis.tier,
      distinctDays: analysis.distinctDays, rowsParsed: analysis.counts.rows,
      capabilities: analysis.capabilities, warnings: analysis.warnings,
      mapping: analysis.mapping, unmapped: analysis.unmapped, data: data2,
    });
    meta.setActiveAccount(account);
    assert.equal((await meta.loadLiveCampaigns()).length, 2, "first batch still has exactly its own campaigns");
    meta.setActiveAccount(second);
    assert.equal((await meta.loadLiveCampaigns()).length, 2, "second batch likewise");
    const total = await pool.query(`SELECT count(*)::int AS n FROM meta_campaigns`);
    assert.equal(total.rows[0].n, 4, "both batches coexist in the table");
    assert.ok(await uploads.deleteBatch(second));
    const after = await pool.query(`SELECT count(*)::int AS n FROM meta_campaigns`);
    assert.equal(after.rows[0].n, 2, "deleting a batch removes only its rows");
  });

  await check("deleting a batch cascades to its day rows", async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM meta_adset_daily`);
    assert.ok(before.rows[0].n > 0);
    await uploads.deleteBatch(account);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM meta_adset_daily`);
    assert.equal(rows.rows[0].n, 0);
    assert.equal((await uploads.listBatches()).length, 0);
  });

  await pool.end();
  console.log(`\n${pass} checks passed.`);
}

if (process.exitCode) console.log("\nSOME CHECKS FAILED");
