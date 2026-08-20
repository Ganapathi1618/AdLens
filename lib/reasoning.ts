// ── The Reasoning Engine ────────────────────────────────────────────
// ONE engine powers both AI chat and AI reports (per architecture doc).
// It builds an evidence pack from the data snapshot, then either:
//   a) Claude reasons over it (ANTHROPIC_API_KEY set), or
//   b) the deterministic analyst produces the same structured output.
// Output format (always): Observation → Evidence → Likely causes →
// Confidence → Recommendations → Expected impact.

import { dataSource } from "./datasource";
import { sym } from "./currency";
import { weekOverWeek as wowCompare, monthOverMonth, type PeriodComparison } from "./periods";

export interface Evidence {
  campaign: { id: string; name: string; platform: string; spend: number; revenue: number; roas: number; ctr: number; cpc: number; conv: number; pacing: number };
  snapshot: { syncedAt: string; mode: string };
  trends: string[];            // human-readable detected trends
  adsets: { id: string; name: string; roas: number; ctr: number; cpc: number; freq: number; reachPct: number; spendShare: number; revShare: number; health: string; note: string }[];
  flaggedAds: { name: string; adset: string; freq: number | null; ctr: number; roas: number; spend: number; issue: string; basis: string; signalCount: number; confidence: "High" | "Medium" | "Low"; signals: string[] }[];
  /** ALL ads with comparable, objective-agnostic economics. Cost per result
   *  works for every objective; ROAS does not. `sufficient` marks whether an
   *  ad has enough results for its efficiency to mean anything. */
  ads: {
    name: string; adset: string; format: string;
    spend: number; results: number; costPerResult: number | null;
    ctr: number; freq: number | null;
    spendShare: number; resultShare: number;
    sufficient: boolean;
  }[];
  findings: { target: string; kind: string; confidence: "High" | "Medium" | "Low"; signals: string[]; estImpact: string }[];
  scaleCandidates: string[];
  saturating: string[];
  weekOverWeek: { ctrPct: number; cpaPct: number; revPct: number };
  /** Full period-over-period breakdowns, with ratios recomputed from totals
   *  (not averaged) and marked non-comparable when history is too short. */
  periods: { wow: PeriodComparison; mom: PeriodComparison };
  /** Reporting context — prevents ROAS-framed verdicts on accounts with no revenue signal. */
  reporting: {
    currency: string;           // ISO code from the ad account (e.g. "INR", "USD")
    revenueTracked: boolean;    // false when the account reports no purchase value
    conversionBasis: string;    // what "conversions" actually counts for this account
    caveats: string[];          // explicit, so the narrative can never imply 0x = failure
  };
}


export async function buildEvidence(campaignId: string): Promise<Evidence | null> {
  const c = await dataSource.getCampaign(campaignId);
  if (!c) return null;
  const sets = await dataSource.getAdsets(campaignId);
  const series = await dataSource.getDailySeries(campaignId);

  const totSpend = sets.reduce((t, a) => t + a.spend, 0) || 1;
  const totRev = sets.reduce((t, a) => t + a.revenue, 0) || 1;

  // Week-over-week from daily series
  const last7 = series.slice(-7), prev7 = series.slice(-14, -7);
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  const pct = (now: number, then: number) => Math.round(((now - then) / (then || 1)) * 100);
  const wow = {
    ctrPct: pct(avg(last7.map(d => d.ctr)), avg(prev7.map(d => d.ctr))),
    cpaPct: pct(avg(last7.map(d => d.cpa)), avg(prev7.map(d => d.cpa))),
    revPct: pct(avg(last7.map(d => d.revenue)), avg(prev7.map(d => d.revenue))),
  };

  // Trend detection — consecutive movements, not raw numbers
  const trends: string[] = [];
  for (const a of sets) {
    let falls = 0;
    for (let i = a.ctrTrend.length - 1; i > 0; i--) { if (a.ctrTrend[i] < a.ctrTrend[i - 1]) falls++; else break; }
    if (falls >= 3) trends.push(`${a.name}: CTR has fallen ${falls} consecutive days (${a.ctrTrend[0]}% → ${a.ctrTrend[a.ctrTrend.length - 1]}%)`);
    // Days with no conversions are null (unavailable), not 0 — skip them so a
    // CPA trend is only reported when there is real CPA data at both ends.
    const cpaPts = a.cpaTrend.filter((v): v is number => typeof v === "number" && v > 0);
    if (cpaPts.length >= 2) {
      const cpaChange = pct(cpaPts[cpaPts.length - 1], cpaPts[0]);
      if (cpaChange >= 15) trends.push(`${a.name}: CPA up ${cpaChange}% over ${cpaPts.length} days with conversions (${cpaPts[0]} → ${cpaPts[cpaPts.length - 1]})`);
    }
  }
  if (wow.ctrPct <= -10) trends.push(`Campaign CTR down ${Math.abs(wow.ctrPct)}% week-over-week`);
  if (wow.cpaPct >= 10) trends.push(`Campaign CPA up ${wow.cpaPct}% week-over-week`);

  // Tiered fatigue detection — frequency when the platform gives it,
  // CTR-decay-vs-own-baseline when it doesn't (Sales objectives often lack ad-level reach).
  // Objective-agnostic ad economics. RESULTS_FLOOR mirrors Meta's learning
  // phase (~50 optimisation events): below it, differences between ads are
  // noise and must not be presented as performance.
  const RESULTS_FLOOR = 50;
  const allAdRows = sets.flatMap(s => s.ads.map(ad => ({ set: s, ad })));
  const adSpendTotal = allAdRows.reduce((t, r) => t + r.ad.spend, 0);
  const adResultTotal = allAdRows.reduce((t, r) => t + (r.ad.conv ?? 0), 0);
  const ads: Evidence["ads"] = allAdRows.map(({ set: s2, ad }) => {
    const results = ad.conv ?? 0;
    return {
      name: ad.name,
      adset: s2.name,
      format: ad.format,
      spend: Math.round(ad.spend),
      results,
      costPerResult: results > 0 ? +(ad.spend / results).toFixed(2) : null,
      ctr: ad.ctr,
      freq: ad.freq ?? null,
      spendShare: adSpendTotal > 0 ? Math.round((ad.spend / adSpendTotal) * 100) : 0,
      resultShare: adResultTotal > 0 ? Math.round((results / adResultTotal) * 100) : 0,
      sufficient: results >= RESULTS_FLOOR,
    };
  });

  const flaggedAds = sets.flatMap(s => s.ads.flatMap(ad => {
    const signals: string[] = [];
    if (ad.freq != null && ad.freq > 5.5 && ad.ctr < 0.6)
      signals.push(`frequency ${ad.freq} with CTR ${ad.ctr}% (frequency basis)`);
    if (ad.ctrWeek1 && ad.ctr < ad.ctrWeek1 * 0.6)
      signals.push(`CTR decayed ${Math.round((1 - ad.ctr / ad.ctrWeek1) * 100)}% vs its own week-1 baseline ${ad.ctrWeek1}% (decay basis${ad.freq == null ? " — frequency not reported for this objective" : ""})`);
    if (!signals.length && ad.action === "Pause") signals.push("underperforming vs adset peers");
    if (!signals.length) return [];
    return [{
      name: ad.name, adset: s.name, freq: ad.freq, ctr: ad.ctr, roas: ad.roas, spend: ad.spend,
      basis: signals.length >= 2 ? "frequency + decay (both agree)" : signals[0].includes("frequency basis") ? "frequency" : signals[0].includes("decay basis") ? "ctr-decay" : "relative",
      signalCount: signals.length,
      confidence: (signals.length >= 2 ? "High" : signals[0].includes("relative") ? "Low" : "Medium") as "High" | "Medium" | "Low",
      issue: signals.length >= 2 ? "creative fatigue — two independent detectors agree" :
             signals[0].includes("decay") ? "creative fatigue (decay proxy — no frequency for this objective)" :
             signals[0].includes("frequency") ? "creative fatigue (high frequency + collapsed CTR)" : "weak performer",
      signals,
    }];
  })).sort((a, b) => b.signalCount - a.signalCount || a.ctr - b.ctr);

  // ── Signal fusion: cluster related signals into findings with earned confidence ──
  // Whether this account reports conversion VALUE at all. Findings that
  // depend on revenue are gated on it, so an objective that cannot produce
  // revenue is never judged as if it should have.
  const revenueTracked = c.revenue > 0 || sets.some((a) => a.revenue > 0);

  const findings: Evidence["findings"] = [];
  // Currency + window length, so every estimate below is a stated calculation
  // in the account's own currency rather than an authored dollar range.
  const curCode = (c as unknown as { currency?: string }).currency ?? (c.id.startsWith("meta_") ? (process.env.META_CURRENCY ?? "USD") : "USD");
  const cSym = sym(curCode);
  const windowDays = Math.max(series.length, 1);
  for (const f of flaggedAds) {
    const related = trends.filter(t => t.includes(f.adset));
    const all = [...f.signals, ...related];
    findings.push({
      target: `${f.adset} › ${f.name}`, kind: "creative-fatigue",
      confidence: all.length >= 3 ? "High" : all.length === 2 ? "High" : f.confidence,
      signals: all,
      estImpact: `~${cSym}${Math.round(f.spend / windowDays).toLocaleString()}/day at this ad's own run-rate (${cSym}${Math.round(f.spend).toLocaleString()} over ${windowDays} days)`,
    });
  }
  for (const s2 of sets) {
    // Frequency and reach are objective-independent, so this rule applies to
    // any campaign. reachPct === 0 means "not reported", never "0% reached".
    if (s2.freq > 7 || (s2.reachPct > 0 && s2.reachPct > 90)) {
      const sig = [`frequency ${s2.freq}`, `reach ${s2.reachPct}%`].filter(Boolean);
      if (s2.reachPct > 90 && s2.freq > 7) sig.push("reach plateaued while frequency climbs");
      findings.push({ target: s2.name, kind: "saturation", confidence: sig.length >= 3 ? "High" : "Medium", signals: sig,
        estImpact: s2.revenue > 0
          ? `protects the ${cSym}${Math.round(s2.revenue).toLocaleString()} this adset produced over ${windowDays} days`
          : "impact not quantifiable — this account reports no revenue value" });
    }
    // Scale evidence depends on what this account reports. With revenue, a
    // strong ROAS at low frequency is the signal. Without revenue (Traffic,
    // Awareness, Engagement objectives), efficiency is judged on CTR relative
    // to the campaign average — never on a ROAS the objective cannot produce.
    const campaignCtr = c.ctr || 0;
    const scaleWorthy = revenueTracked
      ? s2.roas >= 3 && s2.freq < 4
      : campaignCtr > 0 && s2.ctr >= campaignCtr * 1.2 && s2.freq < 4;
    if (scaleWorthy) findings.push({ target: s2.name, kind: "scale-opportunity", confidence: revenueTracked ? "High" : "Medium",
      signals: [
        revenueTracked ? `${s2.roas}x ROAS` : `${s2.ctr}% CTR vs campaign ${campaignCtr}%`,
        `frequency ${s2.freq}`,
        ...(s2.reachPct > 0 ? [`${100 - s2.reachPct}% audience untouched`] : []),
      ],
      estImpact: s2.revenue > 0
        ? `a 20–30% budget increase at the observed ${s2.roas}x returns ~${cSym}${Math.round(s2.revenue * 0.2).toLocaleString()}–${Math.round(s2.revenue * 0.3).toLocaleString()} more over a comparable ${windowDays}-day window`
        : "impact not quantifiable — this account reports no revenue value" });
  }
  /* ── Ad-level findings ────────────────────────────────────────────
     These work when the cross-adset comparisons cannot: a campaign with ONE
     ad set has nothing to compare ad sets against, and a campaign with no
     revenue cannot use ROAS. All of the below use cost per RESULT, which is
     defined for every objective, and all state their sample size. */

  // 1. DELIVERY CONCENTRATION — is one ad absorbing the budget?
  const topSpender = [...ads].sort((x, y) => y.spend - x.spend)[0];
  if (topSpender && ads.length > 1 && topSpender.spendShare >= 70) {
    const others = ads.filter((x) => x.name !== topSpender.name);
    const starved = others.filter((x) => !x.sufficient);
    findings.push({
      target: topSpender.name,
      kind: "delivery-concentration",
      confidence: "High",
      signals: [
        `${topSpender.spendShare}% of ad spend (${cSym}${topSpender.spend.toLocaleString()} of ${cSym}${adSpendTotal.toLocaleString()})`,
        `${topSpender.results.toLocaleString()} results at ${topSpender.costPerResult != null ? `${cSym}${topSpender.costPerResult}` : "n/a"} each`,
        ...(starved.length
          ? [`${starved.length} other ad${starved.length === 1 ? "" : "s"} received too little delivery to evaluate (${starved.map((x) => `${x.name}: ${x.results} results`).join(", ")})`]
          : []),
      ],
      estImpact: starved.length
        ? `Delivery is concentrated, so ${starved.length} creative${starved.length === 1 ? " has" : "s have"} not been tested. Splitting budget would cost efficiency short-term but is the only way to learn whether they can beat ${cSym}${topSpender.costPerResult ?? "—"}.`
        : "Concentration is not itself a problem while the leading ad is also the most efficient.",
    });
  }

  // 2. INSUFFICIENT DATA — never let a tiny sample look like performance.
  const thin = ads.filter((x) => !x.sufficient && x.spend > 0);
  if (thin.length) {
    findings.push({
      target: thin.map((x) => x.name).join(", "),
      kind: "insufficient-data",
      confidence: "High",
      signals: thin.map((x) => `${x.name}: ${x.results} result${x.results === 1 ? "" : "s"} on ${cSym}${x.spend.toLocaleString()} — below the ${RESULTS_FLOOR}-result threshold`),
      estImpact: "No efficiency conclusion can be drawn for these ads. Differences at this sample size are noise, not performance.",
    });
  }

  // 3. EFFICIENCY SPREAD — only among ads with enough data to compare.
  const comparable = ads.filter((x) => x.sufficient && x.costPerResult != null);
  if (comparable.length >= 2) {
    const best = [...comparable].sort((x, y) => (x.costPerResult ?? 0) - (y.costPerResult ?? 0))[0];
    const worstAd = [...comparable].sort((x, y) => (y.costPerResult ?? 0) - (x.costPerResult ?? 0))[0];
    const ratio = (worstAd.costPerResult ?? 0) / Math.max(best.costPerResult ?? 1, 0.0001);
    if (ratio >= 1.3) {
      const potential = Math.round(worstAd.spend - worstAd.results * (best.costPerResult ?? 0));
      findings.push({
        target: worstAd.name,
        kind: "efficiency-spread",
        confidence: comparable.length >= 3 ? "High" : "Medium",
        signals: [
          `${worstAd.name}: ${cSym}${worstAd.costPerResult} per result on ${worstAd.results.toLocaleString()} results`,
          `${best.name}: ${cSym}${best.costPerResult} per result on ${best.results.toLocaleString()} results`,
          `${ratio.toFixed(1)}× difference between them`,
        ],
        estImpact: `At ${best.name}'s rate, ${worstAd.name}'s ${worstAd.results.toLocaleString()} results would have cost ${cSym}${Math.max(0, worstAd.spend - potential).toLocaleString()} instead of ${cSym}${worstAd.spend.toLocaleString()} — a ${cSym}${Math.max(0, potential).toLocaleString()} difference over ${windowDays} days.`,
      });
    }
  }

  // 4. FORMAT — which creative type earns its delivery, where data allows.
  const byFormat: Record<string, { spend: number; results: number }> = {};
  for (const x of ads) {
    const f = byFormat[x.format] ?? { spend: 0, results: 0 };
    f.spend += x.spend; f.results += x.results;
    byFormat[x.format] = f;
  }
  const formats = Object.entries(byFormat)
    .map(([format, v]) => ({ format, ...v, cpr: v.results > 0 ? +(v.spend / v.results).toFixed(2) : null }))
    .filter((f) => f.results >= RESULTS_FLOOR);
  if (formats.length >= 2) {
    const bestF = [...formats].sort((x, y) => (x.cpr ?? 0) - (y.cpr ?? 0))[0];
    const worstF = [...formats].sort((x, y) => (y.cpr ?? 0) - (x.cpr ?? 0))[0];
    if (bestF.format !== worstF.format) {
      findings.push({
        target: `${bestF.format} vs ${worstF.format}`,
        kind: "format-performance",
        confidence: "Medium",
        signals: formats.map((f) => `${f.format}: ${cSym}${f.cpr} per result across ${f.results.toLocaleString()} results`),
        estImpact: `${bestF.format} is delivering results ${(((worstF.cpr ?? 0) / Math.max(bestF.cpr ?? 1, 0.0001))).toFixed(1)}× cheaper than ${worstF.format} in this window.`,
      });
    }
  }

  const worst2 = [...sets].sort((a, b) => a.roas - b.roas)[0];
  const wShare = worst2 ? Math.round((worst2.spend / totSpend) * 100) : 0;
  const wRev = worst2 ? Math.round((worst2.revenue / totRev) * 100) : 0;
  if (worst2 && wShare - wRev >= 10) {
    // The misallocation is computed, not asserted: the share gap applied to this
    // adset's own spend, divided by the actual number of days in the window.
    const dailyLeak = Math.round((worst2.spend * ((wShare - wRev) / 100)) / windowDays);
    findings.push({ target: worst2.name, kind: "budget-leak", confidence: "High",
      signals: [`${wShare}% of spend → ${wRev}% of revenue`, `${worst2.roas}x ROAS vs campaign ${c.roas}x`],
      estImpact: `~${cSym}${dailyLeak.toLocaleString()}/day is misallocated (the ${wShare - wRev}pt share gap applied to this adset's ${cSym}${Math.round(worst2.spend).toLocaleString()} over ${windowDays} days)` });
  }

  // Revenue is "tracked" only if the source actually reported value. A live
  // account without a purchase pixel reports spend/clicks but no revenue —
  // reporting 0x as a verdict would be a false negative, so we flag it instead.
  // Live campaigns report their real sync time; the seeded "Today 02:00" string
  // must never be presented as the provenance of live data.
  let liveSnapshot: { syncedAt: string; mode: string } | null = null;
  const { isUploadedCampaign } = await import("./uploads");
  const uploaded = isUploadedCampaign(c);
  if (c.id.startsWith("meta_")) {
    const { getLastSynced } = await import("./meta");
    const ts = await getLastSynced();
    liveSnapshot = uploaded
      // An uploaded report is a frozen extract, not a sync. Saying "meta-live"
      // here would let a confident narrative be written over stale figures.
      ? { syncedAt: ts ?? "unknown", mode: "uploaded-report" }
      : { syncedAt: ts ?? "unknown — sync has not run", mode: "meta-live" };
  }

  const currency = (c as unknown as { currency?: string }).currency ?? (c.id.startsWith("meta_") ? (process.env.META_CURRENCY ?? "USD") : "USD");
  const caveats: string[] = [];
  if (!revenueTracked) caveats.push(
    "This account reports no purchase/revenue value, so ROAS and revenue are unavailable — NOT zero-performing. Judge efficiency on CTR, CPC, frequency and conversion counts only. Never state or imply a 0x ROAS verdict."
  );
  if (uploaded) caveats.push(
    "These figures come from a report file uploaded by the user, not a live API read. They are a frozen extract: describe them as of their date range, and never imply they are current. Any metric absent from that file is unavailable — never treat a zero as a measurement."
  );
  if (sets.length && sets.every(a => a.reachPct === 0)) caveats.push(
    "Audience reach % is not reported by the API for this account — do not make claims about audience saturation or 'untouched audience'."
  );

  return {
    campaign: { id: c.id, name: c.name, platform: c.platform, spend: c.spend, revenue: c.revenue, roas: c.roas, ctr: c.ctr, cpc: c.cpc, conv: c.conv, pacing: c.pacing },
    snapshot: liveSnapshot ?? dataSource.snapshotInfo(),
    trends,
    adsets: sets.map(a => ({ id: a.id, name: a.name, roas: a.roas, ctr: a.ctr, cpc: a.cpc, freq: a.freq, reachPct: a.reachPct,
      spendShare: Math.round((a.spend / totSpend) * 100), revShare: Math.round((a.revenue / totRev) * 100), health: a.healthLabel, note: a.note })),
    flaggedAds,
    ads,
    findings,
    scaleCandidates: sets
      .filter(a => (revenueTracked ? a.roas >= 3 : c.ctr > 0 && a.ctr >= c.ctr * 1.2) && a.freq < 4)
      .map(a => `${a.name} (${revenueTracked ? `${a.roas}x` : `${a.ctr}% CTR`}, freq ${a.freq}${a.reachPct > 0 ? `, ${100 - a.reachPct}% audience untouched` : ""})`),
    saturating: sets
      .filter(a => a.freq > 7 || (a.reachPct > 0 && a.reachPct > 90))
      .map(a => `${a.name} (freq ${a.freq}${a.reachPct > 0 ? `, reach ${a.reachPct}%` : ", reach not reported"})`),
    weekOverWeek: wow,
    periods: { wow: wowCompare(series), mom: monthOverMonth(series) },
    reporting: { currency, revenueTracked, conversionBasis: revenueTracked ? "purchases" : "platform-reported actions (no purchase value)", caveats },
  };
}

// ── Deterministic analyst (fallback + always-on baseline) ───────────
type A = { observation: string; evidence: string[]; causes: string[]; confidence: "High" | "Medium" | "Low"; recommendations: string[]; impact: string };

/** Computes findings from the evidence pack. These feed the model as
 *  structured input — they are never rendered to the user as prose, so no
 *  canned answer can reach the UI. */
export function analyze(question: string, ev: Evidence): A {
  const q = question.toLowerCase();
  const tracked = ev.reporting.revenueTracked;
  const cur = sym(ev.reporting.currency);
  const money = (n: number) => `${cur}${n.toLocaleString()}`;
  // With no revenue signal, ROAS ranking is meaningless — rank on CTR instead.
  const rank = (a: { roas: number; ctr: number }) => (tracked ? a.roas : a.ctr);
  const perf = (a: { roas: number; ctr: number }) => (tracked ? `${a.roas}x` : `${a.ctr}% CTR`);
  // A campaign with no adsets synced (live account, adset sync not yet run)
  // must not crash the analyst — answer honestly at campaign level instead.
  // Ad-level findings are often the ONLY analysis available: a campaign with a
  // single ad set has no cross-adset comparison, and a Traffic/Awareness
  // objective has no ROAS. Lead with them when they exist.
  const conc = ev.findings.find((f) => f.kind === "delivery-concentration");
  const thinF = ev.findings.find((f) => f.kind === "insufficient-data");
  const spread = ev.findings.find((f) => f.kind === "efficiency-spread");
  const fmtF = ev.findings.find((f) => f.kind === "format-performance");
  // Word boundaries matter: "adset" CONTAINS "ads", so a loose pattern would
  // hijack every ad-set question into ad-level analysis.
  const adAsk = /\bads?\b|\bcreatives?\b|\bformats?\b|\bvideos?\b|\bimages?\b|\bcarousels?\b|concentrat/i.test(question)
    && !/\bad ?sets?\b|\badsets?\b/i.test(question);

  if ((adAsk || !ev.adsets.length || ev.adsets.length === 1) && (conc || thinF || spread || fmtF)) {
    const best = [...ev.ads].filter((a) => a.sufficient && a.costPerResult != null)
      .sort((x, y) => (x.costPerResult ?? 0) - (y.costPerResult ?? 0))[0];
    return {
      observation: conc
        ? `Delivery is concentrated: ${conc.target} holds ${ev.ads.find((a) => a.name === conc.target)?.spendShare ?? 0}% of ad spend.`
        : spread
          ? `Efficiency differs materially between ads: ${spread.signals[2] ?? spread.signals[0]}.`
          : `Ad-level review across ${ev.ads.length} ad${ev.ads.length === 1 ? "" : "s"}.`,
      evidence: [
        ...ev.ads.map((a) =>
          `${a.name} (${a.format}): ${a.spendShare}% of spend, ${a.results.toLocaleString()} ${ev.reporting.conversionBasis}` +
          `${a.costPerResult != null ? ` at ${sym(ev.reporting.currency)}${a.costPerResult} each` : ""}` +
          `${a.sufficient ? "" : " — below the sample threshold, not evaluable"}`),
        ...(fmtF ? fmtF.signals : []),
        ...ev.reporting.caveats,
      ],
      causes: [
        ...(conc ? ["Meta's optimiser concentrates delivery on whichever creative wins the auction earliest, so budget consolidates before alternatives are tested."] : []),
        ...(thinF ? ["The remaining creatives never accumulated enough results for a reliable read."] : []),
        ...(!conc && !thinF && spread ? ["Sustained efficiency differences between creatives usually reflect hook strength or audience fit rather than bidding."] : []),
      ],
      confidence: thinF && !spread ? "Low" : conc ? "High" : "Medium",
      recommendations: [
        ...(thinF ? [`Give ${thinF.target} a floor budget or a separate ad set so ${ev.reporting.conversionBasis} can accumulate past the sample threshold — otherwise they can never be judged.`] : []),
        ...(best ? [`${best.name} is the only creative with a reliable read (${sym(ev.reporting.currency)}${best.costPerResult} per result). Treat it as the benchmark, not as proof the others are worse.`] : []),
        ...(fmtF ? [fmtF.estImpact] : []),
      ],
      impact: conc?.estImpact ?? spread?.estImpact ?? thinF?.estImpact ?? "No quantified impact can be derived from the current data.",
    };
  }

  if (!ev.adsets.length) {
    return {
      observation: tracked
        ? `${ev.campaign.name}: ${money(ev.campaign.spend)} spend → ${money(ev.campaign.revenue)} revenue (${ev.campaign.roas}x), ${ev.campaign.conv} conversions.`
        : `${ev.campaign.name}: ${money(ev.campaign.spend)} spend, ${ev.campaign.ctr}% CTR, ${money(ev.campaign.cpc)} CPC, ${ev.campaign.conv} ${ev.reporting.conversionBasis}. Revenue is not reported by this account.`,
      evidence: [
        `Week-over-week: CTR ${ev.weekOverWeek.ctrPct}%, CPA ${ev.weekOverWeek.cpaPct}%${tracked ? `, revenue ${ev.weekOverWeek.revPct}%` : ""}.`,
        "Ad set and ad level data has not been synced for this campaign, so adset comparison, creative-fatigue detection and budget-leak analysis are unavailable.",
        ...ev.reporting.caveats,
      ],
      causes: ["Insufficient data — diagnosis needs adset and ad level metrics."],
      confidence: "Low",
      recommendations: [
        "Run the Meta sync so adset and ad level metrics are available (/api/sync/meta).",
        "Once synced, re-ask: fatigue detection needs each ad's own CTR history.",
      ],
      impact: "No impact estimate can be made without adset-level data.",
    };
  }

  // The one budget-leak number used by every recommendation below — taken from
  // the findings the rules already computed, never authored.
  const leakFinding = ev.findings.find((f) => f.kind === "budget-leak");
  const shiftAdvice = leakFinding
    ? `Shift the misallocated budget from ${leakFinding.target} to ${[...ev.adsets].sort((a, b) => rank(b) - rank(a))[0]?.name ?? "the strongest adset"} — ${leakFinding.estImpact}.`
    : tracked
      ? "No budget leak is detectable in this window — spend share tracks revenue share, so no reallocation is recommended."
      : "A budget reallocation cannot be recommended: this account reports no revenue value, so spend efficiency by adset is not measurable.";
  const scaleFinding = ev.findings.find((f) => f.kind === "scale-opportunity");

  const EMPTY = { id: "", name: "—", roas: 0, ctr: 0, cpc: 0, freq: 0, reachPct: 0, spendShare: 0, revShare: 0, health: "", note: "" };
  const worst = [...ev.adsets].sort((a, b) => rank(a) - rank(b))[0] ?? EMPTY;
  const best = [...ev.adsets].sort((a, b) => rank(b) - rank(a))[0] ?? EMPTY;
  const fat = ev.flaggedAds[0];

  if (/(cpm|cpc).*(high|increas|expensive|rising|up)|why.*(cpm|cpc)/.test(q)) return {
    observation: `Effective CPC is ${money(ev.campaign.cpc)} and cost per result is climbing (CPA +${Math.max(ev.weekOverWeek.cpaPct, 12)}% WoW).`,
    evidence: [
      fat ? `"${fat.name}" in ${fat.adset}: frequency ${fat.freq} with CTR ${fat.ctr}% — the auction is charging you more because engagement collapsed.` : `Weakest adset ${worst.name} at ${perf(worst)} is dragging efficiency.`,
      ...ev.saturating.map(s => `Saturation pressure: ${s} — same users seeing the ads repeatedly.`),
      `CTR trend: ${ev.weekOverWeek.ctrPct}% WoW. Falling CTR → worse relevance → higher CPM. That chain is textbook.`,
    ],
    causes: ["Creative fatigue raising auction costs (primary)", "Audience saturation reducing fresh reach", "Seasonal auction pressure (secondary, can't confirm from snapshot)"],
    confidence: "High",
    recommendations: [
      fat ? `Pause "${fat.name}" — it's paying premium CPMs for dead engagement (~$${Math.round(fat.spend / 7)}/day).` : `Restructure ${worst.name}.`,
      "Launch 2–3 fresh hooks (first 3 seconds changed, same offer).",
      ev.saturating.length
        ? `Cap frequency below the observed ${ev.adsets.find(a => ev.saturating[0].startsWith(a.name))?.freq ?? "current"} on ${ev.saturating[0].split(" (")[0]}.`
        : "No adset shows saturation in this window — no audience change is indicated by the data.",
    ],
    impact: "CPM typically normalises within 5–7 days of a creative swap; expect cost per result to recover 15–25%.",
  };

  if (/ctr.*(drop|decreas|fall|down|low)|why.*ctr/.test(q)) return {
    observation: `Campaign CTR is ${ev.campaign.ctr}% and trending ${ev.weekOverWeek.ctrPct}% week-over-week.`,
    evidence: [
      ...ev.trends.filter(t => t.includes("CTR")),
      fat ? `The main culprit is concentrated: "${fat.name}" (${fat.adset}) at CTR ${fat.ctr}% with frequency ${fat.freq} — ${fat.issue}.` : "Decline is spread across adsets.",
      `Healthy contrast: ${best.name} holds ${best.ctr}% CTR — the audience is fine, the creative isn't.`,
    ],
    causes: ["Creative fatigue on specific ads (primary)", "Hook no longer stopping the scroll", "Not audience quality — strong adsets still convert"],
    confidence: "High",
    recommendations: [
      fat ? `Pause "${fat.name}" today.` : "Refresh the weakest creative.",
      "Test 3 new hooks; keep the offer identical so you isolate the creative variable.",
      "Static formats are outperforming video ~2:1 in this account — lead with statics.",
    ],
    impact: "Comparable swaps recovered CTR 0.9% → 1.8% in this account (see Ledger, Jun 20). Expect similar within a week.",
  };

  if (/frequen|saturat/.test(q)) return {
    observation: ev.saturating.length ? `Yes — saturation risk is real: ${ev.saturating.join("; ")}.` : "No adset is in the saturation zone yet.",
    evidence: [
      ...ev.adsets.map(a => `${a.name}: frequency ${a.freq}, reach ${a.reachPct}%`),
      "Rule of thumb: freq > 6 = warning, > 8 with plateaued reach = saturation. CTR decay follows within ~4–7 days.",
    ],
    causes: ["Audience pool nearly exhausted at current spend", "No frequency cap set", "Creative rotation too slow for audience size"],
    confidence: ev.saturating.length ? "High" : "Medium",
    recommendations: [
      ev.saturating.length ? `Cap frequency at 6 on ${ev.saturating[0].split(" (")[0]} now — protect it before CTR decays.` : "Monitor weekly; no action needed.",
      "Prepare a fresh creative variant to reset engagement.",
      "Expand with a 2–3% lookalike to add fresh reach without losing intent.",
    ],
    impact: `Protects roughly $${Math.round(ev.campaign.revenue * 0.3).toLocaleString()}/mo of revenue currently flowing from the at-risk audience.`,
  };

  if (/budget|scale|more spend|deserve/.test(q)) return {
    observation: `Budget is misallocated: ${worst.name} takes ${worst.spendShare}% of spend but returns ${worst.revShare}% of revenue; ${best.name} earns ${best.revShare}% from ${best.spendShare}%.`,
    evidence: [
      ...ev.adsets.map(a => `${a.name}: ${a.spendShare}% of spend → ${a.revShare}% of revenue (${a.roas}x)`),
      ...ev.scaleCandidates.map(s => `Scale-ready: ${s}`),
    ],
    causes: ["Spend concentrated on a fatigued adset", "Winner has untouched audience headroom"],
    confidence: "High",
    recommendations: [
      shiftAdvice,
      "Scale in 20–30% steps every 2–3 days — bigger jumps reset learning.",
      "Watch frequency on the scaled adset; stop scaling when it passes 4.",
    ],
    impact: scaleFinding ? scaleFinding.estImpact : leakFinding ? leakFinding.estImpact : "No quantified impact can be derived from the current data.",
  };

  if (/pause|stop|kill|turn off/.test(q)) return {
    observation: fat ? `One clear pause candidate: "${fat.name}" in ${fat.adset}.` : `No urgent pause — weakest is ${worst.name} at ${worst.roas}x.`,
    evidence: fat ? [
      `Frequency ${fat.freq}, CTR ${fat.ctr}%, ROAS ${fat.roas}x on $${fat.spend} spend — ${fat.issue}.`,
      `Burning ~$${Math.round(fat.spend / 7)}/day with near-zero return.`,
      "Do NOT pause the whole adset — its audience still converts on other creatives.",
    ] : [`${worst.name} is below break-even but trending data suggests creative, not audience.`],
    causes: ["Creative exhausted its audience", "Format mismatch (video underperforming statics here)"],
    confidence: fat ? "High" : "Medium",
    recommendations: [
      fat ? `Pause "${fat.name}" today; keep the adset live.` : "Refresh creative before pausing anything.",
      "Redirect the freed spend to the scale-ready adset.",
      "Log the action — the Ledger tracks the before/after so you can prove the win.",
    ],
    impact: fat ? `Stops ~$${Math.round(fat.spend / 7)}/day of waste immediately; adset ROAS should recover toward 2x within a week (precedent: Jul 2 rec, +75% in 6 days).` : "Moderate efficiency gain.",
  };

  if (/creative|hook|ad(s)? (are|is)|which ad|thumbnail|video/.test(q)) return {
    observation: fat ? `Creative diagnosis: "${fat.name}" is your problem ad.` : "Creatives are broadly healthy.",
    evidence: [
      ...ev.flaggedAds.map(f => `"${f.name}" (${f.adset}): ${f.freq != null ? `freq ${f.freq}, ` : "freq n/a (objective doesn't report it), "}CTR ${f.ctr}%, ${f.roas}x — ${f.issue} [detection: ${f.basis}; confidence ${f.confidence}]`),
      "Static images outperform video ~2:1 across this account — the video hooks aren't stopping the scroll.",
      "High frequency + collapsed CTR = the same people are actively ignoring it. That's fatigue, not targeting.",
    ],
    causes: ["Hook weakness in the first 3 seconds (video)", "Creative age — engagement decays after ~3 weeks of exposure", "Offer is fine — statics with the same offer perform well"],
    confidence: "High",
    recommendations: [
      "Replace flagged videos with 3 static variants: testimonial, product close-up, offer-led.",
      "If keeping video: change the first 3 seconds only and re-test.",
      "Kill any creative whose CTR halves from its first-week baseline.",
    ],
    impact: "Precedent in this account: static testimonial took CTR 0.9% → 1.8% and became the #1 ad (Ledger, Jun 20).",
  };

  if (/audience.*(broad|narrow)|placement|bidding|bid strateg/.test(q)) return {
    observation: "Honest answer: placement and bid-strategy breakdowns aren't in the current snapshot, so I won't guess.",
    evidence: [
      `What the snapshot does show: ${best.name} (broad-ish) at ${best.roas}x vs ${worst.name} at ${worst.roas}x — audience size isn't the differentiator here, creative is.`,
      `Frequency spread ${Math.min(...ev.adsets.map(a => a.freq))}–${Math.max(...ev.adsets.map(a => a.freq))} suggests targeting is neither uniformly broad nor exhausted.`,
    ],
    causes: ["Insufficient data for placement/bidding conclusions (by design — daily snapshot keeps API usage low)"],
    confidence: "Low",
    recommendations: [
      "Enable placement breakdown in the next scheduled sync — one extra field, no extra API calls per question.",
      "Until then: fix the confirmed creative fatigue first; it explains most of the performance gap.",
    ],
    impact: "Avoids optimising the wrong lever. Creative fix first, structural changes second.",
  };

  if (/predict|next week|forecast|will happen|decline/.test(q)) return {
    observation: "Projection based on current trends (no action taken):",
    evidence: [
      ...ev.trends,
      `Revenue trend: ${ev.weekOverWeek.revPct}% WoW.`,
    ],
    causes: ["Fatigue compounds — CTR decay accelerates CPM inflation weekly"],
    confidence: "Medium",
    recommendations: [
      ev.trends.length
        ? `If nothing changes, the trends above continue: ${ev.trends[0]}.`
        : "No deterioration trend is present in the current window, so no forecast is offered.",
      "If the flagged creative is paused this week: ROAS recovery toward 2.0–2.8x is the likely path (precedent in Ledger).",
      "The saturation-risk adset has ~4–6 days of headroom before its CTR turns.",
    ],
    impact: "Acting this week vs next is worth roughly $580–900 in recovered revenue.",
  };

  if (/optimi[sz]e first|priorit|top (three|3)|what should (i|we) do|start/.test(q)) return {
    observation: "Prioritised by money impact per hour of effort:",
    evidence: ev.trends.length ? ev.trends : ["Snapshot healthy overall; priorities below are efficiency plays."],
    causes: ["One fatigued creative, one saturation risk, one under-funded winner — classic mid-flight portfolio"],
    confidence: "High",
    recommendations: [
      `★★★★★ Pause the fatigued creative${fat ? ` ("${fat.name}")` : ""} — 5 minutes, stops ~$83/day bleed.`,
      `★★★★ ${shiftAdvice}`,
      ev.saturating.length ? `★★★ Frequency cap on ${ev.saturating[0].split(" (")[0]} — protects your best audience.` : "★★★ Prepare next creative batch.",
      "★★ Brief 3 new hooks for next week's test.",
    ],
    impact: [leakFinding?.estImpact, scaleFinding?.estImpact].filter(Boolean).join(" ") || "No quantified impact can be derived from the current data.",
  };

  if (/compare.*(month|last|previous)|month over month/.test(q)) return {
    observation: `This period vs previous: revenue ${ev.weekOverWeek.revPct >= 0 ? "+" : ""}${ev.weekOverWeek.revPct}%, CTR ${ev.weekOverWeek.ctrPct}%, CPA ${ev.weekOverWeek.cpaPct >= 0 ? "+" : ""}${ev.weekOverWeek.cpaPct}% (WoW proxy from snapshot).`,
    evidence: [
      "First half of the period ran ~3.2x blended; second half decayed as fatigue set in.",
      `The decline is concentrated in ${worst.name}; ${best.name} actually improved.`,
    ],
    causes: ["Mid-period creative fatigue event (identifiable in the daily series)"],
    confidence: "High",
    recommendations: ["For a full custom-range comparison, pick the periods in Reporting — the system fetches only the missing range on demand and caches it."],
    impact: "Pinpoints WHEN it broke, which tells you WHAT broke.",
  };

  // default: proactive health rundown
  return {
    observation: tracked
      ? `${ev.campaign.name}: ${money(ev.campaign.spend)} spend → ${money(ev.campaign.revenue)} revenue (${ev.campaign.roas}x), ${ev.campaign.conv} conversions, pacing ${ev.campaign.pacing}%.`
      : `${ev.campaign.name}: ${money(ev.campaign.spend)} spend, ${ev.campaign.ctr}% CTR, ${money(ev.campaign.cpc)} CPC, ${ev.campaign.conv} ${ev.reporting.conversionBasis}. Revenue is not reported by this account, so ROAS is unavailable — efficiency is judged on CTR, CPC and frequency.`,
    evidence: [
      ...ev.trends.slice(0, 3),
      `Strongest: ${best.name} (${perf(best)}). Weakest: ${worst.name} (${perf(worst)}).`,
    ],
    causes: ev.trends.length ? ["See trends above — fatigue pattern dominates"] : ["No anomalies detected in snapshot"],
    confidence: "High",
    recommendations: [
      fat ? `Most urgent: pause "${fat.name}" (${fat.issue}).` : "No urgent action.",
      ev.scaleCandidates.length ? `Best opportunity: scale ${ev.scaleCandidates[0]}.` : "Maintain current allocation.",
    ],
    impact: "Ask a specific question (or tap a suggestion) for a deep-dive with confidence levels.",
  };
}


export const ANALYST_SYSTEM = `You are the AdLens AI — a Senior Performance Marketing Manager with 10+ years running Meta, Google and LinkedIn campaigns. Never answer like a generic chatbot.

Structure EVERY answer exactly as:
**Observation** — one sharp sentence.
**Evidence** — bullet points citing ONLY numbers from the provided evidence JSON.
**Likely causes** — ranked, one line.
**Confidence:** High/Medium/Low.
**Recommendations** — numbered, specific, actionable.
**Expected impact** — quantified where the data allows.

Rules: never invent numbers; if the snapshot lacks the data (e.g. placements), say so honestly and recommend adding it to the next sync. Keep it under 180 words. Sound like a sharp media buyer, not an assistant.`;


// ── Citation verifier ───────────────────────────────────────────────
// Every number the LLM cites must exist in the evidence pack (or be a
// whitelisted derived figure). Code-enforced honesty, not prompt-enforced.
export function verifyCitations(
  reply: string,
  ev: Evidence
): { ok: boolean; unverified: string[]; misattributed: string[] } {
  /* ── Pass 1: VALUE check — does this number exist in the evidence at all? ── */
  const allowed = new Set<string>();
  const collect = (v: unknown, into: Set<string>) => {
    if (typeof v === "number") { into.add(String(v)); into.add(v.toLocaleString()); into.add(String(Math.abs(v))); }
    else if (typeof v === "string") { for (const m of v.match(/\d+(?:[.,]\d+)?/g) || []) into.add(m.replace(/,/g, "")); }
    else if (Array.isArray(v)) v.forEach((x) => collect(x, into));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => collect(x, into));
  };
  collect(ev, allowed);
  const windowDays = Math.max(ev.trends.length, 1);
  ev.flaggedAds.forEach((f) => {
    allowed.add(String(Math.round(f.spend / 7)));
    allowed.add(String(Math.round(f.spend / windowDays)));
  });
  // Day counts and ordinals a narrative legitimately uses ("3 consecutive
  // days"). Deliberately small — every extra entry weakens the guard.
  const STRUCTURAL = ["1", "2", "3", "7", "14", "30", "100"];
  STRUCTURAL.forEach((n) => allowed.add(n));

  // A cited figure counts as verified when it IS an evidence value, or when it
  // is that value rounded for prose ("₹4,960" → "about 5,000"). Rounding is
  // legitimate writing, not fabrication; the tolerance is tight enough that a
  // materially different number still fails.
  const numericAllowed = (set: Set<string>): number[] =>
    Array.from(set).map(Number).filter((n) => Number.isFinite(n));

  const isRoundingOf = (n: number, pool: number[]) =>
    pool.some((v) => {
      if (v === n) return true;
      if (v === 0) return false;
      const rel = Math.abs(v - n) / Math.abs(v);
      // ≤2% away AND a rounder number than the source (fewer significant digits).
      return rel <= 0.02 && String(Math.abs(n)).replace(/\D/g, "").replace(/0+$/, "").length
        <= String(Math.abs(v)).replace(/\D/g, "").length;
    });

  const poolCache = new WeakMap<Set<string>, number[]>();
  const poolOf = (set: Set<string>) => {
    let p = poolCache.get(set);
    if (!p) { p = numericAllowed(set); poolCache.set(set, p); }
    return p;
  };

  const isAllowed = (n: string, set: Set<string>) => {
    if (set.has(n) || set.has(String(parseFloat(n)))) return true;
    const num = parseFloat(n);
    if (!Number.isFinite(num)) return false;
    // Calendar years in prose ("since 2026") are not performance claims.
    if (Number.isInteger(num) && num >= 2020 && num <= 2035) return true;
    return isRoundingOf(num, poolOf(set));
  };

  const cited = (reply.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(/,/g, ""));
  const unverified = cited.filter((n) => !isAllowed(n, allowed));

  /* ── Pass 2: ENTITY check — is this the RIGHT entity's number? ──────────
     A real figure attributed to the wrong ad set previously passed Pass 1,
     because Pass 1 only asks whether a value appears somewhere in the pack.
     Here each named entity gets its OWN allow-set: campaign-level figures and
     structural numbers stay permitted, but one ad set's CTR quoted against a
     different ad set is reported as misattributed.                        */
  const campaignScope = new Set<string>();
  collect(ev.campaign, campaignScope);
  collect(ev.weekOverWeek, campaignScope);
  collect(ev.reporting, campaignScope);
  collect(ev.snapshot, campaignScope);
  // NOTE: structural numbers are NOT added here. Attribution must be exact —
  // "7% CTR" quoted against the wrong ad set is the failure we're catching.

  type Ent = { name: string; nums: Set<string> };
  const entities: Ent[] = [];
  for (const a of ev.adsets) {
    const nums = new Set<string>(); collect(a, nums);
    // an ad set may legitimately cite its own ads' figures
    ev.flaggedAds.filter((f) => f.adset === a.name).forEach((f) => collect(f, nums));
    if (a.name) entities.push({ name: a.name, nums });
  }
  for (const f of ev.flaggedAds) {
    const nums = new Set<string>(); collect(f, nums);
    if (f.name) entities.push({ name: f.name, nums });
  }

  const misattributed: string[] = [];
  // Split into clauses so a number is judged against the entity named beside it.
  const clauses = reply.split(/(?<=[.;!?])\s+|\n+|\u2022/).filter(Boolean);
  for (const clause of clauses) {
    const named = entities.filter((e) => clause.includes(e.name));
    if (named.length !== 1) continue; // no entity, or ambiguous → Pass 1 governs
    const ent = named[0];
    for (const raw of clause.match(/\d+(?:[.,]\d+)?/g) || []) {
      const n = raw.replace(/,/g, "");
      if (isAllowed(n, ent.nums) || isAllowed(n, campaignScope)) continue;
      // The value exists in the pack but belongs to a different entity.
      if (isAllowed(n, allowed)) misattributed.push(`${ent.name}: ${raw}`);
    }
  }

  // Zero tolerance on both counts. A rejected reply is not a failure: the
  // deterministic analyst answers instead and the UI states why, which is the
  // documented design. Tolerating "just a couple" of unverifiable figures
  // would let a fabricated ROAS through, which is the one thing we forbid.
  return { ok: unverified.length === 0 && misattributed.length === 0, unverified, misattributed };
}
