"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid, AreaChart, Area } from "recharts";
import { FileText, Wallet, DollarSign, Target, MousePointerClick, Coins, Repeat, TrendingUp, Activity, Users, RefreshCw } from "lucide-react";
import { getCampaign, adsetsFor, series30 } from "@/lib/data";
import type { Campaign, AdSet } from "@/lib/data";
import { sym } from "@/lib/currency";
import { PRESETS as RANGE_PRESETS, type PresetKey } from "@/lib/daterange";
import { resultLadder, actionLabel, CORE_METRICS, type MetricKey } from "@/lib/meta-labels";
import { useApp } from "@/lib/store";
import { PlatBadge, StatusBadge, HealthDot, RankBadge, ActionPill, CreativeScore } from "@/components/Badge";
import Sparkline from "@/components/Sparkline";
import { KpiHero } from "@/components/KpiHero";
import HealthScore from "@/components/HealthScore";
import PacingCard from "@/components/PacingCard";
import AISummary from "@/components/AISummary";
import InsightCard from "@/components/InsightCard";
import ChartCard, { TOOLTIP_STYLE, AXIS_TICK } from "@/components/ChartCard";
import PeriodCompare from "@/components/PeriodCompare";
import type { PeriodComparison } from "@/lib/periods";
import clsx from "clsx";

// which direction is GOOD for each metric — so colours mean something, not math
const GOOD_UP: Record<string, boolean | null> = { spend: null, revenue: true, roas: true, ctr: true, cpc: false, freq: false };
function tone(key: string, delta: string): "good" | "bad" | "flat" {
  const up = delta.includes("↑"); const dn = delta.includes("↓");
  if (!up && !dn) return "flat";
  const g = GOOD_UP[key];
  if (g === null || g === undefined) return "flat";
  return (up && g) || (dn && !g) ? "good" : "bad";
}
const VERDICT: Record<string, { text: string; cls: string }> = {
  female: { text: "Best return — but audience tiring", cls: "pill-warn" },
  male: { text: "Burning cash — fix first", cls: "pill-bad" },
  lla: { text: "Ready to scale", cls: "pill-good" },
  broad: { text: "Steady — leave it running", cls: "pill-accent" },
};

// Seeded demo keeps its original presets; live campaigns use the real
// platform-defined ranges resolved in the ad account's timezone.
const PRESETS = ["Daily", "Weekly", "Monthly", "Overall", "Custom"] as const;

export default function Analysis({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();
  const { setCampaign } = useApp();

  const isLive = id.startsWith("meta_");
  const [rangeKey, setRangeKey] = useState<PresetKey>("last_30");
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<MetricKey[]>(["spend", "results", "cost_per_result", "ctr", "cpc", "impressions"]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadingRange, setLoadingRange] = useState(false);

  const [liveData, setLiveData] = useState<{ campaign: Campaign; adsets: AdSet[]; series: { day: string; ctr: number; cpa: number; spend: number; revenue: number }[]; currency: string; adsetError?: string | null; seriesError?: string | null; adsetsInAccount?: { id: string; name: string; campaignId: string; campaignName: string | null; days: number }[]; range?: { since: string; until: string; days: number; label: string; metaPreset: string | null }; coverage?: { requested: { since: string; until: string; days: number }; returned: { since: string | null; until: string | null; days: number }; complete: boolean; empty: boolean }; provenance?: { kind: "upload" | "graph" | "seeded"; label: string; detail: string | null; tier: string | null; capabilities: { key: string; label: string; available: boolean; reason: string }[]; warnings: string[]; uploadedAt: string | null; accountId: string }; timezone?: string } | null>(null);
  const [liveErr, setLiveErr] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  async function resync() {
    setSyncing(true); setSyncMsg("Syncing campaigns → ad sets → ads from Meta…");
    try {
      const r = await fetch(`/api/sync/meta?campaign=${encodeURIComponent(id.replace("meta_", ""))}&preset=last_30&t=${Date.now()}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.synced) { setSyncMsg(`Sync failed: ${d.error ?? d.reason ?? "unknown"}`); return; }
      const mine = (d.hierarchy ?? []).find((h: { campaignId: string }) => h.campaignId === (c?.metaId ?? id.replace("meta_", "")));
      setSyncMsg(mine
        ? `Synced. This campaign now has ${mine.adsets} ad set${mine.adsets === 1 ? "" : "s"} and ${mine.ads} ad${mine.ads === 1 ? "" : "s"}. Reloading…`
        : `Synced ${d.adsets ?? 0} ad sets and ${d.ads ?? 0} ads. Reloading…`);
      setTimeout(() => window.location.reload(), 1200);
    } catch (e: any) {
      setSyncMsg(`Sync failed: ${e?.message ?? "network error"}`);
    } finally {
      setSyncing(false);
    }
  }
  useEffect(() => {
    if (!isLive) return;
    if (rangeKey === "custom" && !(customSince && customUntil)) return;
    setLoadingRange(true);
    setRangeError(null);
    const qs = new URLSearchParams({ id, preset: rangeKey, t: String(Date.now()) });
    if (rangeKey === "custom") { qs.set("since", customSince); qs.set("until", customUntil); }
    fetch(`/api/db/campaign-detail?${qs}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error ?? "request failed");
        return d;
      })
      .then((d) => { setLiveData(d); setLiveErr(false); })
      .catch((e) => { setRangeError(e?.message ?? "failed to load range"); setLiveErr(true); })
      .finally(() => setLoadingRange(false));
  }, [id, isLive, rangeKey, customSince, customUntil]);

  // Provenance drives more than a label: metrics absent from an uploaded file
  // must read as "not reported", never as a measured 0.
  const isUpload = liveData?.provenance?.kind === "upload";
  const unavailable = (liveData?.provenance?.capabilities ?? []).filter((cap) => !cap.available);

  const c = isLive ? liveData?.campaign ?? null : getCampaign(id) ?? null;
  const cur = sym(isLive ? liveData?.currency ?? c?.currency : "USD");
  const [tab, setTab] = useState<"overview" | "trends" | "adsets" | "ads" | "audience">("overview");

  // Real WoW / MoM for this campaign, computed server-side from the daily
  // series. Never rendered until it arrives — no placeholder percentages.
  const [periods, setPeriods] = useState<{ wow: PeriodComparison; mom: PeriodComparison } | null>(null);
  const [periodsError, setPeriodsError] = useState<string | null>(null);

  // Fetched once per campaign, not per tab switch.
  useEffect(() => {
    let cancelled = false;
    setPeriods(null);
    setPeriodsError(null);
    fetch(`/api/db/periods?campaign=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.error) setPeriodsError(String(d.error));
        else setPeriods({ wow: d.wow, mom: d.mom });
      })
      .catch((e) => { if (!cancelled) setPeriodsError(e?.message ?? "network error"); });
    return () => { cancelled = true; };
  }, [id]);
  const [compare, setCompare] = useState(false);

  const [preset, setPreset] = useState<(typeof PRESETS)[number]>("Monthly");
  const [from, setFrom] = useState("2025-06-01");
  const [to, setTo] = useState("2025-06-30");
  const [aFrom, setAFrom] = useState("");
  const [aTo, setATo] = useState("");
  const [bFrom, setBFrom] = useState("");
  const [bTo, setBTo] = useState("");
  const [bManual, setBManual] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const onDemand = (f: string, t: string) => {
    setFetchNote(`Fetching ${f} → ${t} on demand…`);
    setTimeout(() => setFetchNote("Range cached ✓ — future queries are instant"), 800);
    setTimeout(() => setFetchNote(null), 3200);
  };

  useEffect(() => { if (c) setCampaign(c.id, c.name); }, [c, setCampaign]);

  const full = useMemo(() => (isLive ? (liveData?.series ?? []) : series30(id)), [isLive, liveData, id]);
  const data = useMemo(() => {
    if (isLive) return full;
    if (preset === "Daily") return full.slice(-1 * 2);
    if (preset === "Weekly") return full.slice(-7);
    return full;
  }, [full, preset, isLive]);

  const allDates = full.map((d) => String((d as Record<string, unknown>).date ?? "")).filter(Boolean);

  useEffect(() => {
    if (!isLive || allDates.length < 2 || aFrom) return;
    const m = Math.floor(allDates.length / 2);
    setAFrom(allDates[m]); setATo(allDates[allDates.length - 1]);
    setBFrom(allDates[0]); setBTo(allDates[Math.max(m - 1, 0)]);
  }, [isLive, allDates.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isLive || bManual || !aFrom || !aTo || allDates.length < 2) return;
    const iFrom = allDates.indexOf(aFrom), iTo = allDates.indexOf(aTo);
    if (iFrom < 0 || iTo < iFrom) return;
    const len = iTo - iFrom + 1;
    const bEnd = iFrom - 1;
    if (bEnd < 0) { setBFrom(""); setBTo(""); return; }
    const bStart = Math.max(0, bEnd - len + 1);
    setBFrom(allDates[bStart]); setBTo(allDates[bEnd]);
  }, [isLive, bManual, aFrom, aTo, allDates.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const rangeKpis = (() => {
    if (!isLive || !data.length) return null;
    const sum = (k: "spend" | "revenue" | "impressions" | "clicks" | "conversions") =>
      data.reduce((t, d) => t + Number((d as Record<string, unknown>)[k] ?? 0), 0);
    const spend = sum("spend"), rev = sum("revenue");
    const impressions = sum("impressions"), clicks = sum("clicks"), conv = sum("conversions");
    const reachVals = data.map((d) => Number((d as Record<string, unknown>).reach ?? 0)).filter((n) => n > 0);
    const freqVals = data.map((d) => Number((d as Record<string, unknown>).frequency ?? 0)).filter((n) => n > 0);
    return {
      hasData: true as const,
      spend, revenue: rev, impressions, clicks, conv,
      roas: rev > 0 && spend > 0 ? +(rev / spend).toFixed(2) : null,
      ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : null,
      cpc: clicks > 0 ? +(spend / clicks).toFixed(2) : null,
      cpm: impressions > 0 ? +((spend / impressions) * 1000).toFixed(2) : null,
      cpa: conv > 0 ? +(spend / conv).toFixed(2) : null,
      reach: reachVals.length ? Math.max(...reachVals) : null,
      frequency: freqVals.length ? +(freqVals.reduce((a, b) => a + b, 0) / freqVals.length).toFixed(2) : null,
      days: data.length,
      from: (data[0] as Record<string, unknown>).date ?? data[0].day,
      to: (data[data.length - 1] as Record<string, unknown>).date ?? data[data.length - 1].day,
    };
  })();
  const revTracked = !isLive || (rangeKpis?.hasData ? (rangeKpis.revenue ?? 0) > 0 : false);
  const availableActions = (() => {
    const totals: Record<string, number> = {};
    for (const a of (liveData?.adsets ?? []) as (AdSet & { actionTotals?: Record<string, number> })[]) {
      for (const [k, v] of Object.entries(a.actionTotals ?? {})) totals[k] = (totals[k] ?? 0) + Number(v || 0);
    }
    return Object.entries(totals).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]);
  })();

  const na = "N/A";

  function metricValue(k: MetricKey): { label: string; value: string; alert?: boolean } {
    const R = rangeKpis;
    const sets2 = (liveData?.adsets ?? []) as (AdSet & { results?: number; resultLabel?: string; actionTotals?: Record<string, number> })[];
    const money = (v: number | null | undefined) => (v == null ? na : `${cur}${Number(v).toLocaleString()}`);
    if (!R || !R.hasData) {
      const lbl = k.startsWith("action:") ? actionLabel(k.slice(7)) : (CORE_METRICS.find((m) => m.key === k)?.label ?? k);
      return { label: lbl, value: na };
    }
    if (k.startsWith("action:")) {
      const t = k.slice(7);
      const total = sets2.reduce((sum, a) => sum + Number(a.actionTotals?.[t] ?? 0), 0);
      return { label: actionLabel(t), value: total.toLocaleString() };
    }
    switch (k) {
      case "spend": return { label: "Spend", value: money(R.spend) };
      case "impressions": return { label: "Impressions", value: (R.impressions ?? 0).toLocaleString() };
      case "reach": return { label: "Reach (peak day)", value: R.reach == null ? na : R.reach.toLocaleString() };
      case "frequency": return { label: "Frequency", value: R.frequency == null ? na : String(R.frequency) };
      case "clicks": return { label: "Clicks", value: (R.clicks ?? 0).toLocaleString() };
      case "ctr": return { label: "CTR", value: R.ctr == null ? na : `${R.ctr}%` };
      case "cpc": return { label: "CPC", value: money(R.cpc) };
      case "cpm": return { label: "CPM", value: money(R.cpm) };
      case "revenue": return { label: "Revenue", value: (R.revenue ?? 0) > 0 ? money(R.revenue) : na };
      case "roas": return { label: "ROAS", value: R.roas == null ? na : `${R.roas}x`, alert: R.roas != null && R.roas < 1.5 };
      case "results": {
        const labels = Array.from(new Set(sets2.map((a) => a.resultLabel).filter(Boolean))) as string[];
        const total = sets2.reduce((sum, a) => sum + Number(a.results ?? 0), 0);
        if (labels.length > 1) return { label: "Results (mixed)", value: `${total.toLocaleString()}*` };
        return { label: labels[0] ? labels[0].replace(/^\w/, (ch) => ch.toUpperCase()) : "Results", value: total.toLocaleString() };
      }
      case "cost_per_result": {
        const total = sets2.reduce((sum, a) => sum + Number(a.results ?? 0), 0);
        const labels = Array.from(new Set(sets2.map((a) => a.resultLabel).filter(Boolean))) as string[];
        if (labels.length > 1) return { label: "Cost per result (mixed)", value: na };
        return { label: "Cost per result", value: total > 0 ? money((R.spend ?? 0) / total) : na };
      }
      default: return { label: String(k), value: na };
    }
  }

  const chosenCards = chosen.map((k) => {
    const m = metricValue(k);
    return [m.label, m.value, m.alert] as [string, string, boolean | undefined];
  });
  const primarySet = (liveData?.adsets ?? [])[0] as (AdSet & { optimizationGoal?: string; destinationType?: string }) | undefined;
  const ladder = resultLadder(c?.objective, primarySet?.optimizationGoal, primarySet?.destinationType);
  const resultsLabel = isLive ? ladder.label : "Conv.";
  const fmtMoney = (v: number | null | undefined) => (v == null ? na : `${cur}${v.toLocaleString()}`);

  const sets = isLive ? (liveData?.adsets ?? []) : adsetsFor(id);
  if (isLive && !liveData && !liveErr) return (
    <div className="p-10 max-w-6xl mx-auto">
      <div className="h-8 w-64 rounded-lg bg-raised animate-pulse mb-6" />
      <div className="grid grid-cols-6 gap-3 mb-5">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-28 rounded-2xl bg-raised animate-pulse" />)}</div>
      <div className="text-[13px] text-mut">Loading live campaign from Meta…</div>
    </div>
  );
  if (!c) return <div className="p-10 text-[14px]">Campaign not found.</div>;

  const mid = Math.floor(full.length / 2);
  const dates = full.map((d) => String((d as Record<string, unknown>).date ?? "")).filter(Boolean);

  const inWindow = (d: typeof full[number], lo: string, hi: string) => {
    const ds = String((d as Record<string, unknown>).date ?? "");
    return ds >= lo && ds <= hi;
  };
  const useCustomWindows = isLive && compare && aFrom && aTo && bFrom && bTo;
  const perA = useCustomWindows ? full.filter((d) => inWindow(d, aFrom, aTo)) : full.slice(0, mid);
  const perB = useCustomWindows ? full.filter((d) => inWindow(d, bFrom, bTo)) : full.slice(mid);
  const div = (num: number, den: number) => (den > 0 ? num / den : 0);
  const roasA = div(perA.reduce((s, d) => s + d.revenue, 0), perA.reduce((s, d) => s + d.spend, 0));
  const roasB = div(perB.reduce((s, d) => s + d.revenue, 0), perB.reduce((s, d) => s + d.spend, 0));
  const canComparePeriods = perA.length >= 3 && perB.length >= 3;
  const cmpLabel = revTracked ? "ROAS" : "CTR";
  const cmpA = revTracked ? roasA : (perA.reduce((t, d) => t + d.ctr, 0) / (perA.length || 1));
  const cmpB = revTracked ? roasB : (perB.reduce((t, d) => t + d.ctr, 0) / (perB.length || 1));
  const cmpUnit = revTracked ? "x" : "%";

  const l7 = full.slice(-7), p7 = full.slice(-14, -7);
  const ctrDeltaPts = l7.length && p7.length
    ? l7.reduce((s2, d) => s2 + d.ctr, 0) / l7.length - p7.reduce((s2, d) => s2 + d.ctr, 0) / p7.length
    : 0;
  const anomalies: { text: string; tone: "bad" | "warn"; go?: "adsets" | "audience" }[] = [];
  for (const a of sets) {
    if (a.health === "critical") anomalies.push({ text: `${a.name} — ${a.healthLabel}`, tone: "bad", go: "adsets" });
    else if (a.freq > 7) anomalies.push({ text: `${a.name} freq ${a.freq}`, tone: "warn", go: "audience" });
  }
  if (ctrDeltaPts < -0.05) anomalies.push({ text: `CTR down ${Math.abs(ctrDeltaPts).toFixed(2)}pts WoW`, tone: "bad" });
  const tot = (a: typeof full, k: "spend" | "revenue" | "ctr") => a.reduce((s, d) => s + (d[k] as number), 0);

  const onTo = (v: string) => setTo(v < from ? from : v);

  // Campaign health score — derived from adset health + anomalies.
  const healthScore = sets.length
    ? Math.max(5, Math.round(100
        - (sets.filter((a) => a.health === "critical").length / sets.length) * 70
        - (sets.filter((a) => a.health === "watch").length / sets.length) * 25
        - (anomalies.length > 2 ? 10 : 0)))
    : (c.health === "critical" ? 30 : c.health === "watch" ? 60 : 85);

  // Creative score for an ad: CTR weight + ROAS weight − fatigue penalty.
  const creativeScore = (ad: { ctr: number; roas: number; freq: number | null }) =>
    Math.max(3, Math.min(98, Math.round(ad.ctr * 22 + ad.roas * 10 - Math.max(0, (ad.freq ?? 0) - 4) * 8)));

  const worst = [...sets].sort((x, y) => x.roas - y.roas)[0];
  const best = [...sets].sort((x, y) => y.roas - x.roas)[0];

  const KPI_ICONS = [Wallet, MousePointerClick, Coins, Activity, DollarSign, Target, Repeat, TrendingUp];

  return (
    <div className="max-w-7xl mx-auto px-8 py-7">
      {/* ── Header ─────────────────────────────────────────────── */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-start justify-between flex-wrap gap-4 mb-5">
        <div>
          <div className="section-label mb-1.5">Campaign analysis</div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="font-display text-[30px] leading-tight tracking-tight">{c.name}</h1>
            <PlatBadge p={c.platform} /><StatusBadge s={c.status} />
          </div>
        </div>
        <div className="flex items-center gap-4">
          <HealthScore score={healthScore} size={84}
            detail={anomalies.length ? `${anomalies.length} ${anomalies.length === 1 ? "anomaly" : "anomalies"} detected` : "no anomalies in window"} />
          <div className="flex flex-col gap-2 items-end">
            <div className="flex items-center gap-2">
              {isLive && (isUpload ? (
                <Link href="/upload" className="btn-ghost" title="Replace this report with a newer export">
                  <RefreshCw size={13} /> Re-upload report
                </Link>
              ) : (
                <button onClick={resync} disabled={syncing} className="btn-ghost" title="Refresh only this campaign from the Meta Ads API">
                  <RefreshCw size={13} className={syncing ? "animate-spin" : undefined} />
                  {syncing ? "Syncing…" : "Sync campaign"}
                </button>
              ))}
              <button onClick={() => router.push("/reporting")} className="btn-primary"><FileText size={14} /> Generate report</button>
            </div>
            {syncMsg && <div className="text-[11px] font-semibold text-accent">{syncMsg}</div>}
            <label className="flex items-center gap-2 text-[12px] font-semibold text-mut cursor-pointer">
              Compare periods
              <button onClick={() => { setCompare(!compare); if (!compare) setTab("overview"); }}
                className={clsx("w-10 h-[22px] rounded-full transition-colors relative", compare ? "bg-accent" : "bg-line2")}>
                <motion.span layout className="absolute top-[3px] w-4 h-4 bg-white rounded-full shadow" animate={{ left: compare ? 21 : 3 }} />
              </button>
            </label>
          </div>
        </div>
      </motion.div>

      {/* ── AI summary (seeded demo only — live gets no fabricated verdicts) ── */}
      {!isLive && worst && best && (
        <AISummary meta={`checked ${sets.length} ad sets`} cta="See the fix" onCta={() => setTab("adsets")}>
          {worst.health === "critical"
            ? <><strong>{worst.name}</strong> is your leak — {worst.roas}x ROAS on {cur}{worst.spend.toLocaleString()} spend, driven by one fatigued creative. Meanwhile <strong>{best.name}</strong> returns {best.roas}x with headroom. Move budget from the first to the second: est. <strong>+{cur}640–1,280/week</strong>.</>
            : <>All ad sets healthy. <strong>{best.name}</strong> leads at {best.roas}x — consider scaling it while frequency stays low.</>}
        </AISummary>
      )}

      {/* ── Range controls ────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 flex-wrap mb-5">
        {!compare ? (
          <>
            {isLive ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="flex rounded-xl border border-line2 bg-surface p-1">
                  {RANGE_PRESETS.map((rp) => (
                    <button key={rp.key} onClick={() => setRangeKey(rp.key)}
                      className={clsx("text-[12px] font-bold px-3 py-1.5 rounded-lg transition-colors",
                        rangeKey === rp.key ? "text-white" : "text-mut hover:text-ink")}
                      style={rangeKey === rp.key ? { background: "var(--hero-grad)" } : undefined}>
                      {rp.label}
                    </button>
                  ))}
                </div>
                {rangeKey === "custom" && (
                  <>
                    <input type="date" value={customSince} max={customUntil || undefined}
                      onChange={(e) => setCustomSince(e.target.value)}
                      className="text-[12px] border border-line2 rounded-xl px-2.5 py-1.5 bg-surface" />
                    <span className="text-[12px] text-mut">to</span>
                    <input type="date" value={customUntil} min={customSince || undefined}
                      onChange={(e) => setCustomUntil(e.target.value)}
                      className="text-[12px] border border-line2 rounded-xl px-2.5 py-1.5 bg-surface" />
                  </>
                )}
                {loadingRange && <span className="text-[12px] text-mut animate-pulse">loading…</span>}
                {rangeError && <span className="text-[12px] text-bad font-bold">{rangeError}</span>}
              </div>
            ) : (
              <div className="flex rounded-xl border border-line2 bg-surface p-1">
                {PRESETS.map((p) => (
                  <button key={p} onClick={() => setPreset(p)} className={clsx("relative text-[12px] font-bold px-3.5 py-1.5 rounded-lg", preset === p ? "text-white" : "text-mut hover:text-ink")}>
                    {preset === p && <motion.span layoutId="preset-pill" className="absolute inset-0 rounded-lg" style={{ background: "var(--hero-grad)" }} transition={{ type: "spring", stiffness: 400, damping: 34 }} />}
                    <span className="relative z-10">{p}</span>
                  </button>
                ))}
              </div>
            )}
            {preset === "Custom" ? (
              <div className="flex items-center gap-1.5 text-[12px]">
                <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); onDemand(e.target.value, to); }} className="border border-line2 rounded-xl px-2.5 py-1.5 bg-surface" />
                <span className="text-mut">to</span>
                <input type="date" value={to} min={from} onChange={(e) => { onTo(e.target.value); onDemand(from, e.target.value); }} className="border border-line2 rounded-xl px-2.5 py-1.5 bg-surface" />
              </div>
            ) : (
              <span className="text-[12px] text-mut font-medium">{isLive
                ? (liveData?.coverage?.empty
                    ? `${liveData?.range?.label ?? "selected range"} — no data in this period`
                    : `${liveData?.range?.since} → ${liveData?.range?.until} · ${liveData?.coverage?.returned.days ?? 0} of ${liveData?.range?.days ?? 0} days with data${liveData?.timezone ? ` · ${liveData.timezone}` : ""}`)
                : preset === "Daily" ? "Today · hourly" : preset === "Weekly" ? "Last 7 days" : preset === "Monthly" ? "Jun 1 – Jun 30, 2025" : "All time"}</span>
            )}
            <span className="pill-mut" title={liveData?.provenance?.detail ?? undefined}>
              {isUpload
                ? `${liveData?.provenance?.label ?? "Uploaded report"} · ${full.length}d`
                : isLive ? `Live · Meta Graph API · ${full.length}d synced` : "Snapshot · Today 02:00"}
            </span>
            {fetchNote && <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={clsx("text-[11px] font-bold", fetchNote.includes("✓") ? "text-good" : "text-accent")}>{fetchNote}</motion.span>}
          </>
        ) : (
          isLive ? (
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="font-bold text-accent">Period A</span>
              <input type="date" value={aFrom} min={dates[0]} max={dates[dates.length - 1]}
                onChange={(e) => setAFrom(e.target.value > aTo ? aTo : e.target.value)}
                className="border border-line2 rounded-xl px-2.5 py-1.5 bg-surface" />
              <span className="text-mut">to</span>
              <input type="date" value={aTo} min={aFrom} max={dates[dates.length - 1]}
                onChange={(e) => setATo(e.target.value < aFrom ? aFrom : e.target.value)}
                className="border border-line2 rounded-xl px-2.5 py-1.5 bg-surface" />
              <span className="font-bold text-accent ml-2">vs Period B{!bManual && " (previous)"}</span>
              <input type="date" value={bFrom} min={dates[0]} max={aFrom || dates[dates.length - 1]}
                onChange={(e) => { setBManual(true); setBFrom(e.target.value > bTo ? bTo : e.target.value); }}
                className="border border-line2 rounded-xl px-2.5 py-1.5 bg-surface" />
              <span className="text-mut">to</span>
              <input type="date" value={bTo} min={bFrom} max={aFrom || dates[dates.length - 1]}
                onChange={(e) => { setBManual(true); setBTo(e.target.value < bFrom ? bFrom : e.target.value); }}
                className="border border-line2 rounded-xl px-2.5 py-1.5 bg-surface" />
              {bManual && (
                <button onClick={() => setBManual(false)} className="text-[11px] font-bold text-accent underline">
                  reset to previous period
                </button>
              )}
              <span className={clsx("ml-1 font-bold", perA.length === 0 || perB.length === 0 ? "text-bad" : perA.length !== perB.length ? "text-warn" : "text-good")}>
                {perA.length === 0
                  ? "Period A has no synced days"
                  : perB.length === 0
                    ? "no earlier period available to compare against"
                    : perA.length !== perB.length
                      ? `${perA.length}d vs ${perB.length}d — unequal windows, compare rates (CTR/CPC) not totals`
                      : `${perA.length}d vs ${perB.length}d — equal windows`}
              </span>
              <span className="text-mut">· data available {dates[0]} → {dates[dates.length - 1]}</span>
            </div>
          ) : (
            <span className="pill-accent">Comparing Period A (Jun 1–15) vs Period B (Jun 16–30)</span>
          )
        )}
      </div>

      {/* Uploaded data: say plainly which metrics the file did not contain, so a
          0 on the cards below is never mistaken for a measurement. */}
      {isUpload && (
        <div className="card p-4 mb-4 border-accent/30" style={{ background: "var(--accent-soft)" }}>
          <div className="text-[13px] font-bold mb-1">
            These figures come from an uploaded report{liveData?.provenance?.detail ? ` — ${liveData.provenance.detail}` : ""}.
          </div>
          <div className="text-[12.5px] text-mut font-medium leading-relaxed">
            They are a frozen extract for the dates above, not a live read.
            {unavailable.length > 0 && (
              <> Not in this file, so shown as not reported rather than zero:{" "}
                <strong className="text-ink">{unavailable.map((cap) => cap.label).join(", ")}</strong>.
              </>
            )}{" "}
            <Link href="/upload" className="text-accent font-bold">Upload a richer export</Link> to unlock the rest.
          </div>
        </div>
      )}

      {isLive && liveData?.coverage?.empty && (
        <div className="card p-4 mb-4 text-[13px]">
          <strong>No data for {liveData?.range?.label}.</strong>{" "}
          <span className="text-mut">
            The account reported no delivery between {liveData?.range?.since} and {liveData?.range?.until}
            {liveData?.timezone ? ` (${liveData.timezone})` : ""}. Nothing is shown rather than figures from another period.
            {" "}If the campaign was active then, run the sync for this range.
          </span>
        </div>
      )}
      {isLive && liveData?.coverage && !liveData.coverage.empty && !liveData.coverage.complete && (
        <div className="rounded-2xl border border-warn/40 p-3.5 mb-4 text-[12px]" style={{ background: "var(--warn-soft)" }}>
          <strong className="text-warn">Partial period.</strong>{" "}
          <span className="text-mut">
            {liveData.coverage.returned.days} of {liveData.coverage.requested.days} days in
            {" "}{liveData.range?.since} → {liveData.range?.until} have stored data. Totals cover only those days.
          </span>
        </div>
      )}

      {/* Results by ad set — each on its own optimisation goal. */}
      {isLive && (liveData?.adsets?.length ?? 0) > 0 && (
        <div className="card p-4 mb-4">
          <div className="text-[14px] font-bold mb-0.5">Results by ad set</div>
          <div className="text-[12px] text-mut mb-3">
            Each ad set is measured by what IT optimises for. These are not summed when the goals differ.
          </div>
          <div className="space-y-1.5">
            {((liveData?.adsets ?? []) as (AdSet & { results?: number; resultLabel?: string; resultBasis?: string; costPerResult?: number | null })[]).map((a) => (
              <div key={a.id} className="flex items-center gap-3 text-[13px] border-t border-line pt-2">
                <span className="font-bold min-w-[170px] truncate">{a.name}</span>
                <span className="text-mut min-w-[150px]">{a.resultLabel ?? "results"}</span>
                <span className="font-bold num">{(a.results ?? 0).toLocaleString()}</span>
                <span className="text-mut num">
                  {a.costPerResult != null ? `${cur}${a.costPerResult} each` : "cost per result n/a"}
                </span>
                <span className="ml-auto text-[11px] text-mut">{a.resultBasis}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Provenance strip — which account, campaign, range, currency. */}
      {isLive && rangeKpis?.hasData && (
        <details className="mb-4 group">
          <summary className="cursor-pointer text-[12px] font-bold text-mut hover:text-ink inline-flex items-center gap-1.5 select-none">
            Data provenance <span className="text-[10px] group-open:rotate-90 transition-transform">▶</span>
          </summary>
          <div className="card p-4 mt-2 text-[12px]">
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {[
                ["Source", "Live · Meta Graph API"],
                ["Campaign ID", c.metaId ?? id.replace("meta_", "")],
                ["Status", `${c.status} (as of last sync)`],
                ["Objective", c.objective || "N/A"],
                ["Currency", liveData?.currency ?? "N/A"],
                ["Range", `${liveData?.range?.since ?? rangeKpis.from} → ${liveData?.range?.until ?? rangeKpis.to} (${liveData?.range?.days ?? rangeKpis.days}d requested, ${rangeKpis.days}d with data)`],
                ["Timezone", liveData?.timezone ?? "—"],
                ["Impressions", rangeKpis.impressions ? rangeKpis.impressions.toLocaleString() : "N/A"],
                ["Reach (peak day)", rangeKpis.reach ? rangeKpis.reach.toLocaleString() : "N/A"],
                ["Frequency", rangeKpis.frequency ?? "N/A"],
                ["CPM", fmtMoney(rangeKpis.cpm)],
                [`Cost per ${resultsLabel.replace(/s$/, "")}`, rangeKpis.cpa == null ? "N/A — no results in range" : fmtMoney(rangeKpis.cpa)],
                ["Results counted as", `${resultsLabel}${ladder.basis ? ` (${ladder.basis})` : ""}`],
                ["Conv. value", rangeKpis.revenue > 0 ? fmtMoney(rangeKpis.revenue) : "N/A — not reported by this account"],
              ].map(([l, v]) => (
                <span key={String(l)} className="text-mut">
                  {l}: <strong className="text-ink font-bold">{String(v)}</strong>
                </span>
              ))}
            </div>
          </div>
        </details>
      )}

      {/* Metric picker — built from what the platform actually reported. */}
      {isLive && (
        <div className="mb-3 flex items-center gap-2 flex-wrap">
          <button onClick={() => setPickerOpen((v) => !v)} className="btn-ghost !py-1.5 !text-[12px]">
            {pickerOpen ? "Done" : "Customise metrics"}
          </button>
          {!pickerOpen && (
            <span className="text-[12px] text-mut font-medium">{chosen.length} shown · {availableActions.length} result type{availableActions.length === 1 ? "" : "s"} reported</span>
          )}
          {pickerOpen && (
            <div className="w-full card p-4 mt-1">
              <div className="section-label mb-2">Delivery &amp; cost</div>
              <div className="flex flex-wrap gap-1.5 mb-3.5">
                {CORE_METRICS.map((m) => {
                  const on = chosen.includes(m.key);
                  return (
                    <button key={m.key}
                      onClick={() => setChosen((c2) => on ? c2.filter((k) => k !== m.key) : [...c2, m.key])}
                      className={clsx("text-[12px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors",
                        on ? "text-white border-transparent" : "border-line2 text-mut hover:text-ink")}
                      style={on ? { background: "var(--hero-grad)" } : undefined}>
                      {m.label}
                    </button>
                  );
                })}
              </div>
              <div className="section-label mb-2">Results reported by this campaign</div>
              <div className="flex flex-wrap gap-1.5">
                {availableActions.length === 0 && (
                  <span className="text-[12px] text-mut">No action types reported in this window.</span>
                )}
                {availableActions.map(([t, v]) => {
                  const key = `action:${t}` as MetricKey;
                  const on = chosen.includes(key);
                  return (
                    <button key={t}
                      onClick={() => setChosen((c2) => on ? c2.filter((k) => k !== key) : [...c2, key])}
                      className={clsx("text-[12px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors",
                        on ? "text-white border-transparent" : "border-line2 text-mut hover:text-ink")}
                      style={on ? { background: "var(--hero-grad)" } : undefined}>
                      {actionLabel(t)} <span className="opacity-70 num">{v.toLocaleString()}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── KPI hero row ──────────────────────────────────────── */}
      <div className="grid grid-cols-6 gap-3 mb-4">
        {isLive && rangeKpis ? (
          chosenCards.map(([label, value, alert], i) => {
            const Icon = KPI_ICONS[i % KPI_ICONS.length];
            return <KpiHero key={String(label)} i={i} label={String(label)} rawValue={String(value)} icon={Icon} alert={!!alert} />;
          })
        ) : (
          ([
            ["Spend", `${cur}${c.spend.toLocaleString()}`, "↑12%", Wallet, false],
            ["Revenue", `${cur}${c.revenue.toLocaleString()}`, "↑7%", DollarSign, false],
            ["ROAS", `${c.roas}x`, "↓0.9x", Target, c.roas < 1.5 || id === "summer-sale"],
            ["CTR", `${c.ctr}%`, "↓0.3pts", MousePointerClick, false],
            ["CPC", `${cur}${c.cpc}`, "↑$0.62", Coins, false],
            [resultsLabel, String(c.conv), "↑8%", Activity, false],
          ] as [string, string, string, typeof Wallet, boolean][]).map(([l, v, d, Icon, alert], i) => {
            const t = tone(l.toLowerCase(), d);
            return <KpiHero key={l} i={i} label={l} rawValue={v} icon={Icon} alert={alert}
              delta={d} deltaTone={t === "good" ? "good" : t === "bad" ? "bad" : "neutral"} />;
          })
        )}
      </div>

      {/* ── Pacing + anomalies ────────────────────────────────── */}
      <div className="grid grid-cols-[290px_1fr] gap-3 mb-5">
        <PacingCard pacing={isLive && c.pacing === 0 ? 0 : c.pacing} spend={c.spend} cur={cur} />
        {anomalies.length > 0 ? (
          <div className="card p-4 border-bad/25 relative overflow-hidden">
            <span className="absolute left-0 top-0 bottom-0 w-1 bg-bad" />
            <div className="flex items-center gap-2 mb-2.5">
              <span className="pill-bad">⚠ {anomalies.length} {anomalies.length === 1 ? "anomaly" : "anomalies"}</span>
              <span className="text-[12px] text-mut font-medium">click one to jump to the evidence</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {anomalies.map((an, i) => (
                <button key={i} onClick={() => an.go && setTab(an.go)}
                  className={clsx("text-[12.5px] font-semibold px-3 py-1.5 rounded-xl border transition-all hover:-translate-y-0.5",
                    an.tone === "bad"
                      ? "border-bad/40 text-bad hover:bg-bad/10"
                      : "border-warn/40 text-warn hover:bg-warn/10")}>
                  {an.text} →
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="card p-4">
            <span className="pill-good">✓ No anomalies detected in this window</span>
            <div className="text-[12px] text-mut mt-2">
              {sets.length === 0
                ? "Ad set data is required for creative-fatigue and saturation checks — none is synced for this campaign."
                : `Checked ${sets.length} ad set${sets.length === 1 ? "" : "s"} for CTR decline, frequency saturation and week-over-week movement.`}
            </div>
          </div>
        )}
      </div>

      {/* ── Tabs ──────────────────────────────────────────────── */}
      <div className="flex gap-1 p-1 rounded-xl bg-raised w-fit mb-5">
        {(["overview", "trends", "adsets", "ads", "audience"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={clsx("relative px-4 py-2 text-[13px] font-bold rounded-lg capitalize transition-colors", tab === t ? "text-ink" : "text-mut hover:text-ink")}>
            {tab === t && <motion.span layoutId="tab-pill" className="absolute inset-0 bg-surface rounded-lg shadow-card" transition={{ type: "spring", stiffness: 400, damping: 34 }} />}
            <span className="relative z-10">{t === "adsets" ? "Ad sets" : t === "ads" ? "Creatives" : t === "audience" ? "Audience" : t === "trends" ? "WoW / MoM" : "Overview"}</span>
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={tab + String(compare)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
          {tab === "overview" && (
            <>
              {compare && (
                <div className="mb-4">
                  <div className="rounded-2xl px-4 py-3 text-[13px] mb-3 border border-accent/25" style={{ background: "var(--accent-soft)" }}>
                    <span className="font-bold text-accent">Period A</span> {isLive ? `${aFrom || "—"} → ${aTo || "—"}` : "Jun 1–15"} &nbsp;vs&nbsp; <span className="font-bold text-good">Period B</span> {isLive ? (bFrom ? `${bFrom} → ${bTo}` : "no earlier period with data") : "Jun 16–30"}
                  </div>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <ChartCard title={`${revTracked ? "Revenue" : "Daily spend"} — A vs B`}>
                      <ResponsiveContainer width="100%" height={170}>
                        <LineChart data={perA.map((d, i) => ({
                          i: i + 1,
                          a: revTracked ? d.revenue : d.spend,
                          b: revTracked ? perB[i]?.revenue : perB[i]?.spend,
                        }))}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false} />
                          <XAxis dataKey="i" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                          <YAxis tick={AXIS_TICK} width={40} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={TOOLTIP_STYLE} />
                          <Line dataKey="a" name="Period A" stroke="var(--chart1)" strokeWidth={2.5} dot={false} />
                          <Line dataKey="b" name="Period B" stroke="var(--chart-good)" strokeWidth={2.5} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </ChartCard>
                    <ChartCard title={`${revTracked ? "ROAS" : "CTR"} by period`}>
                      <ResponsiveContainer width="100%" height={170}>
                        <BarChart data={[{ n: "Period A", v: +cmpA.toFixed(2) }, { n: "Period B", v: +cmpB.toFixed(2) }]}>
                          <XAxis dataKey="n" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                          <YAxis tick={AXIS_TICK} width={32} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--raised)" }} />
                          <Bar dataKey="v" radius={[8, 8, 0, 0]} fill="var(--chart1)" />
                        </BarChart>
                      </ResponsiveContainer>
                    </ChartCard>
                  </div>
                  {canComparePeriods && (() => {
                    const sum = (arr: typeof perA, k: "spend" | "revenue") => arr.reduce((t, d) => t + Number(d[k] ?? 0), 0);
                    const avg = (arr: typeof perA, k: "ctr") => (arr.length ? arr.reduce((t, d) => t + Number(d[k] ?? 0), 0) / arr.length : 0);
                    const sameLength = perA.length === perB.length;
                    const pct = (a: number, b: number) => (b === 0 ? null : ((a - b) / b) * 100);
                    const rows: { metric: string; a: string; b: string; delta: number | null; better: boolean }[] = [];
                    const money = (v: number) => `${cur}${Math.round(v).toLocaleString()}`;
                    if (sameLength) rows.push({ metric: "Spend", a: money(sum(perA, "spend")), b: money(sum(perB, "spend")),
                      delta: pct(sum(perA, "spend"), sum(perB, "spend")), better: true });
                    rows.push({ metric: "CTR", a: `${avg(perA, "ctr").toFixed(2)}%`, b: `${avg(perB, "ctr").toFixed(2)}%`,
                      delta: pct(avg(perA, "ctr"), avg(perB, "ctr")), better: avg(perA, "ctr") >= avg(perB, "ctr") });
                    if (revTracked && sameLength) rows.push({ metric: "Revenue", a: money(sum(perA, "revenue")), b: money(sum(perB, "revenue")),
                      delta: pct(sum(perA, "revenue"), sum(perB, "revenue")), better: sum(perA, "revenue") >= sum(perB, "revenue") });
                    return (
                      <div className="card overflow-hidden mb-3">
                        <table className="w-full text-[13px]">
                          <thead><tr className="bg-raised/70 text-mut text-[10px] uppercase tracking-wider">
                            <th className="text-left px-4 py-2.5 font-bold">Metric</th>
                            <th className="text-right px-4 py-2.5 font-bold">Period A</th>
                            <th className="text-right px-4 py-2.5 font-bold">Period B</th>
                            <th className="text-right px-4 py-2.5 font-bold">Change</th>
                          </tr></thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.metric} className="border-t border-line">
                                <td className="px-4 py-2.5 font-bold">{r.metric}</td>
                                <td className="px-4 py-2.5 text-right num">{r.a}</td>
                                <td className="px-4 py-2.5 text-right text-mut num">{r.b}</td>
                                <td className={clsx("px-4 py-2.5 text-right font-bold num",
                                  r.delta == null ? "text-mut" : r.better ? "text-good" : "text-bad")}>
                                  {r.delta == null ? "—" : `${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(1)}%`}
                                </td>
                              </tr>
                            ))}
                            {!sameLength && (
                              <tr className="border-t border-line">
                                <td colSpan={4} className="px-4 py-2.5 text-[12px] text-warn">
                                  Windows differ in length ({perA.length}d vs {perB.length}d) — totals are omitted, only rates are comparable.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                  <div className="card p-4 text-[13px] leading-relaxed text-mut">
                    <span className="font-bold text-ink">What changed: </span>
                    {canComparePeriods
                      ? <>Period B {cmpLabel} ({cmpB.toFixed(cmpUnit === "%" ? 2 : 1)}{cmpUnit}) vs Period A ({cmpA.toFixed(cmpUnit === "%" ? 2 : 1)}{cmpUnit}) — {perA.length}d vs {perB.length}d. {!revTracked && "Revenue isn't reported for this account, so the comparison uses CTR. "}{isLive ? (cmpB < cmpA ? "The second half declined — see the adset table for where the drop concentrated." : "The second half improved.") : (roasB < roasA ? "The second half declined — the 25–44 Male creative fatigue hit mid-month and dragged blended efficiency down." : "The second half improved as top adsets scaled.")}</>
                      : <>Not enough history yet ({full.length} day{full.length === 1 ? "" : "s"} synced). A period comparison needs at least 6 days.</>}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <ChartCard title="CTR & CPA" sub={`${preset.toLowerCase()} view`} icon={MousePointerClick}>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={data}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false} />
                      <XAxis dataKey="day" tick={AXIS_TICK} interval={preset === "Weekly" ? 0 : 5} axisLine={false} tickLine={false} />
                      <YAxis yAxisId="l" tick={AXIS_TICK} width={30} axisLine={false} tickLine={false} />
                      <YAxis yAxisId="r" orientation="right" tick={AXIS_TICK} width={32} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} />
                      <Line yAxisId="l" dataKey="ctr" stroke="var(--chart1)" strokeWidth={2.5} dot={false} name="CTR %" />
                      <Line yAxisId="r" dataKey="cpa" stroke="var(--chart-warn)" strokeWidth={2.5} dot={false} strokeDasharray="5 3" name="CPA $" />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartCard>
                <ChartCard title="Revenue vs spend" icon={DollarSign}>
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={data}>
                      <defs>
                        <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--chart-good)" stopOpacity={0.28} />
                          <stop offset="100%" stopColor="var(--chart-good)" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--chart1)" stopOpacity={0.24} />
                          <stop offset="100%" stopColor="var(--chart1)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false} />
                      <XAxis dataKey="day" tick={AXIS_TICK} interval={preset === "Weekly" ? 0 : 5} axisLine={false} tickLine={false} />
                      <YAxis tick={AXIS_TICK} width={40} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} />
                      <Area dataKey="revenue" stroke="var(--chart-good)" fill="url(#revGrad)" strokeWidth={2.5} name="Revenue" />
                      <Area dataKey="spend" stroke="var(--chart1)" fill="url(#spendGrad)" strokeWidth={2.5} name="Spend" />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
            </>
          )}

          {tab === "trends" && (
            <>
              {periodsError && (
                <div className="card p-5 text-[13px] font-semibold" style={{ color: "var(--bad)" }}>
                  Could not load the period comparison — {periodsError}
                </div>
              )}
              {!periodsError && !periods && (
                <div className="card p-8 text-center text-[13px] text-mut font-medium">Loading period comparison…</div>
              )}
              {periods && <PeriodCompare wow={periods.wow} mom={periods.mom} currency={cur} />}
            </>
          )}

          {tab === "adsets" && (() => {
            const totSpend = sets.reduce((t, a) => t + a.spend, 0);
            const totRev = sets.reduce((t, a) => t + a.revenue, 0);
            const ranked = [...sets].sort((x, y) => y.roas - x.roas);
            return (
              <div className="space-y-4">
                {/* Leaderboard */}
                <div className="grid grid-cols-2 gap-3">
                  {ranked.map((a, i) => {
                    const deltas: [string, string][] = [["roas", a.kpiDeltas.roas], ["revenue", a.kpiDeltas.revenue], ["ctr", a.kpiDeltas.ctr], ["cpc", a.kpiDeltas.cpc]];
                    return (
                      <motion.div key={a.id} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
                        whileHover={{ y: -3 }} onClick={() => router.push(`/adset/${a.id}`)}
                        className={clsx("card p-4 cursor-pointer hover:shadow-lift transition-all group relative overflow-hidden",
                          a.health === "critical" ? "border-bad/30" : "hover:border-accent/40")}>
                        <span className="absolute left-0 top-0 bottom-0 w-1"
                          style={{ background: a.health === "critical" ? "var(--bad)" : i === 0 ? "var(--good)" : "transparent" }} />
                        <div className="flex items-center gap-2 mb-1.5">
                          {i === 0
                            ? <RankBadge rank="top" label="#1 Winner" />
                            : a.health === "critical"
                              ? <RankBadge rank="low" label="Bleeding" />
                              : <span className="pill-mut">#{i + 1}</span>}
                          <span className="font-bold text-[15px]">{a.name}</span>
                          <HealthDot h={a.health} />
                          <span className="ml-auto text-[12px] text-accent opacity-0 group-hover:opacity-100 transition-opacity font-bold">Deep dive →</span>
                        </div>
                        <span className={clsx("mb-3 inline-flex", VERDICT[a.id]?.cls || "pill-mut")}>{VERDICT[a.id]?.text || a.note}</span>
                        <div className="flex items-end gap-4 mb-3">
                          <div>
                            <div className={clsx("font-display num text-[38px] leading-none", a.roas >= 3 ? "text-good" : a.roas < 1.5 ? "text-bad" : "")}>{a.roas}x</div>
                            <div className="text-[10px] text-mut font-bold uppercase tracking-wide mt-1">return on spend</div>
                          </div>
                          <div className="flex-1 pb-1"><Sparkline data={a.ctrTrend} color={a.health === "critical" ? "var(--chart-bad)" : a.roas >= 3 ? "var(--chart-good)" : "var(--chart1)"} h={30} /></div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {deltas.map(([k, v]) => {
                            const t = tone(k, v);
                            return (
                              <span key={k} className={clsx("num", t === "good" ? "pill-good" : t === "bad" ? "pill-bad" : "pill-mut")}>
                                {k.toUpperCase()} {v}
                              </span>
                            );
                          })}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>

                {/* Money in vs money out */}
                <div className="card p-5">
                  <div className="text-[15px] font-bold mb-0.5">Where the money goes vs where it comes back</div>
                  <div className="text-[12px] text-mut mb-4">Grey bar = share of spend · coloured bar = share of revenue. A coloured bar longer than its grey bar = earning more than its share.</div>
                  <div className="space-y-4">
                    {ranked.map((a) => {
                      const sp = totSpend > 0 ? Math.round((a.spend / totSpend) * 100) : 0;
                      const rv = totRev > 0 ? Math.round((a.revenue / totRev) * 100) : 0;
                      const winning = rv >= sp;
                      return (
                        <div key={a.id}>
                          <div className="flex justify-between text-[12.5px] mb-1.5">
                            <span className="font-bold">{a.name}</span>
                            <span className={clsx("font-bold", winning ? "text-good" : "text-bad")}>
                              {totRev <= 0
                                ? `${sp}% of spend · return not reported by this account`
                                : winning ? `earns ${rv}% from ${sp}% of spend ✓` : `takes ${sp}% of spend, returns only ${rv}% ⚠`}
                            </span>
                          </div>
                          <div className="h-2.5 bg-raised rounded-full overflow-hidden mb-1">
                            <motion.div initial={{ width: 0 }} animate={{ width: `${sp}%` }} transition={{ duration: 0.7 }} className="h-full bg-line2 rounded-full" />
                          </div>
                          <div className="h-2.5 bg-raised rounded-full overflow-hidden">
                            <motion.div initial={{ width: 0 }} animate={{ width: `${rv}%` }} transition={{ duration: 0.7, delay: 0.15 }}
                              className={clsx("h-full rounded-full", winning ? "bg-good" : "bg-bad")} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-4 rounded-xl border border-bad/30 px-4 py-3 text-[13px]" style={{ background: "var(--bad-soft)" }}>
                    {(() => {
                      if (liveData?.adsetError) return <><strong className="text-bad">Ad set data failed to load:</strong> {liveData.adsetError}</>;
                      if (!sets.length) {
                        const acct = liveData?.adsetsInAccount ?? [];
                        const mine = c.metaId ?? id.replace("meta_", "");
                        const others = acct.filter((a) => a.campaignId !== mine).length;
                        return (
                          <>
                            <strong>No ad sets stored for this campaign</strong> (id {mine}).
                            {others > 0 && <span className="text-mut"> {others} ad set{others === 1 ? "" : "s"} stored in this account belong{others === 1 ? "s" : ""} to a different campaign id — most likely written by an older sync.</span>}
                            <div className="mt-2.5 flex items-center gap-2.5">
                              <button onClick={resync} disabled={syncing} className="btn-primary !py-1.5 !text-[12px]">
                                {syncing ? "Syncing…" : "Sync ad sets from Meta"}
                              </button>
                              <span className="text-[12px] text-mut">Walks campaign → ad set → ad, so parentage comes from Meta&apos;s own edges.</span>
                            </div>
                            {syncMsg && <div className="mt-1.5 text-[12px] font-bold text-accent">{syncMsg}</div>}
                          </>
                        );
                      }
                      if (totSpend <= 0) return <>Ad sets are stored but report no spend in this window.</>;
                      if (totRev <= 0) return <><strong className="text-bad">Note:</strong> revenue is not reported for this account, so budget-leak analysis (spend share vs revenue share) is unavailable. Compare CTR and CPC in the table below instead.</>;
                      const leak = [...sets].map(a => ({ a, gap: (a.spend / totSpend) - (a.revenue / totRev) })).sort((x, y) => y.gap - x.gap)[0];
                      if (!leak || leak.gap <= 0) return <>No budget leak detected — spend share tracks revenue share across all adsets.</>;
                      const daily = Math.round((leak.a.spend * leak.gap) / 7);
                      return <><strong className="text-bad">The leak:</strong> {leak.a.name} takes <strong>{Math.round((leak.a.spend / totSpend) * 100)}%</strong> of the budget but returns just <strong>{Math.round((leak.a.revenue / totRev) * 100)}%</strong> of revenue — ~{cur}{daily.toLocaleString()}/day going nowhere. Click it above to see exactly which ad is responsible.</>;
                    })()}
                  </div>
                </div>
              </div>
            );
          })()}

          {tab === "ads" && (
            <div className="card overflow-hidden">
              <table className="w-full text-[13px]">
                <thead><tr className="text-left text-[10px] uppercase tracking-wider text-mut bg-raised/70">
                  {["Ad", "Format", "Ad set", "Score", "Spend", "CTR", "ROAS", "Freq", "Action"].map((h) => <th key={h} className="px-4 py-3 font-bold">{h}</th>)}
                </tr></thead>
                <tbody>
                  {sets.flatMap((s) => s.ads.map((ad) => ({ ...ad, adset: s.name }))).map((ad) => (
                    <tr key={ad.id} className={clsx("border-t border-line transition-colors hover:bg-raised/50", ad.action === "Pause" && "bg-bad/[0.04]")}>
                      <td className="px-4 py-3 font-bold">
                        <div className="flex items-start gap-2.5">
                          {ad.thumbnail && (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={ad.thumbnail} alt="" className="w-10 h-10 rounded-lg object-cover border border-line shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="truncate max-w-[220px] flex items-center gap-1.5">
                              {ad.permalink ? <a href={ad.permalink} target="_blank" rel="noreferrer" className="hover:text-accent">{ad.name}</a> : ad.name}
                              {ad.rank === "top" && <RankBadge rank="top" label="Winner" />}
                              {ad.rank === "low" && <RankBadge rank="low" label={ad.rankLabel} />}
                            </div>
                            {ad.title && <div className="text-[11px] text-mut font-normal truncate max-w-[220px]">{ad.title}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-mut">{ad.format}</td>
                      <td className="px-4 py-3 text-mut">{ad.adset}</td>
                      <td className="px-4 py-3"><CreativeScore score={creativeScore(ad)} /></td>
                      <td className="px-4 py-3 num">{cur}{ad.spend.toLocaleString()}</td>
                      <td className={clsx("px-4 py-3 num", ad.ctr > 1.5 ? "text-good font-bold" : ad.ctr < 0.8 ? "text-bad font-bold" : "")}>{ad.ctr}%</td>
                      <td className={clsx("px-4 py-3 font-bold num", ad.roas > 3 ? "text-good" : ad.roas < 1.5 ? "text-bad" : "")}>{ad.roas}x</td>
                      <td className={clsx("px-4 py-3 num", (ad.freq ?? 0) > 5 ? "text-bad font-bold" : "")}>{ad.freq ?? <span className="text-mut" title="Not reported for this objective">—</span>}</td>
                      <td className="px-4 py-3"><ActionPill a={ad.action} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === "audience" && (
            <div className="grid grid-cols-3 gap-3">
              {sets.slice(0, 3).map((a, i) => (
                <motion.div key={a.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}
                  className="card p-4 relative overflow-hidden">
                  <span className="absolute left-0 top-0 bottom-0 w-1"
                    style={{ background: a.freq > 8 ? "var(--warn)" : a.health === "critical" ? "var(--bad)" : "var(--good)" }} />
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-bold text-[14px] flex items-center gap-1.5"><Users size={13} className="text-mut" /> {a.name}</span>
                    <span className={a.freq > 8 ? "pill-warn" : a.health === "critical" ? "pill-bad" : "pill-good"}>
                      {a.freq > 8 ? "Saturating" : a.health === "critical" ? "Critical" : "Healthy"}</span>
                  </div>
                  <div className="flex items-baseline gap-1.5 my-2">
                    <span className={clsx("font-display num text-[32px] leading-none", a.freq > 8 ? "text-warn" : a.health === "critical" ? "text-bad" : "text-good")}>{a.freq}</span>
                    <span className="text-[11px] font-bold uppercase tracking-wide text-mut">avg frequency</span>
                  </div>
                  <div className="h-2 bg-raised rounded-full overflow-hidden mb-2.5">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${a.freq * 10}%` }} transition={{ duration: 0.8 }}
                      className={clsx("h-full rounded-full", a.freq > 8 ? "bg-warn" : a.freq > 5 ? "bg-bad" : "bg-good")} />
                  </div>
                  <p className="text-[12px] text-mut leading-relaxed">{a.reachPct === 0 ? (a.reachAbs ? `Reached ${a.reachAbs.toLocaleString()} unique people at frequency ${a.freq}. Share-of-audience is not reported by the API, so no saturation claim can be made.` : "Audience reach is not reported by the API for this account — no saturation claim can be made.") : a.freq > 8 ? `Cap at 6. Reach ${a.reachPct}%. ~4 days to saturation.` : a.health === "critical" ? "Freq OK — issue is creative fatigue, not audience." : `${100 - a.reachPct}% untouched. Room to scale.`}</p>
                </motion.div>
              ))}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* ── Insight cards from adset intelligence ─────────────── */}
      {!isLive && sets.length > 0 && tab !== "adsets" && (
        <div className="mt-5 space-y-2.5">
          <div className="section-label mb-1">AI insights — {sets.length} ad sets analysed</div>
          {sets.map((a, i) => (
            <InsightCard key={a.id} tag={a.insight.tag} title={`${a.name}: ${a.insight.title}`} body={a.insight.body}
              defaultOpen={i === 0 && a.insight.tag === "issue"}
              action="Open ad set" onAction={() => router.push(`/adset/${a.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}
