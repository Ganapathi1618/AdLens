"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { ArrowLeft, ImageIcon, Video, LayoutGrid, Wallet, DollarSign, Target, MousePointerClick, Coins, Repeat } from "lucide-react";
import type { AdSet } from "@/lib/types";
import { sym } from "@/lib/currency";
import { HealthDot, RankBadge, ActionPill, CreativeScore } from "@/components/Badge";
import { KpiHero } from "@/components/KpiHero";
import InsightCard from "@/components/InsightCard";
import ChartCard, { TOOLTIP_STYLE, AXIS_TICK } from "@/components/ChartCard";
import clsx from "clsx";

export default function AdsetDetail({ params }: { params: { id: string } }) {
  const { id } = params;
  const [a, setAdset] = useState<AdSet | null>(null);
  const [campaignName, setCampaignName] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | undefined>(undefined);
  const [liveErr, setLiveErr] = useState(false);
  useEffect(() => {
    fetch(`/api/db/adset-detail?id=${encodeURIComponent(id)}&t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setAdset(d.adset); setCampaignName(d.campaignName ?? null); if (d.currency) setCurrency(d.currency); })
      .catch(() => setLiveErr(true));
  }, [id]);
  const router = useRouter();
  const cur = sym(currency);
  if (!a) return <div className="p-10 text-[14px]">{liveErr ? "Ad set not found." : "Loading ad set…"}</div>;

  const trend = a.ctrTrend.map((v, i) => ({ d: `D${i + 1}`, ctr: v, cpa: a.cpaTrend[i] }));
  const deltaTone = (d: string, goodUp: boolean | null): "good" | "bad" | "neutral" => {
    const up = d.includes("↑"), dn = d.includes("↓");
    if ((!up && !dn) || goodUp === null) return "neutral";
    return (up && goodUp) || (dn && !goodUp) ? "good" : "bad";
  };
  const creativeScore = (ad: { ctr: number; roas: number; freq: number | null }) =>
    Math.max(3, Math.min(98, Math.round(ad.ctr * 22 + ad.roas * 10 - Math.max(0, (ad.freq ?? 0) - 4) * 8)));

  const FmtIcon = ({ f }: { f: string }) => f === "Video" ? <Video size={26} className="text-mut/40" /> : f === "Carousel" ? <LayoutGrid size={26} className="text-mut/40" /> : <ImageIcon size={26} className="text-mut/40" />;
  const sorted = [...a.ads].sort((x, y) => y.roas - x.roas);

  return (
    <div className="max-w-7xl mx-auto px-8 py-7">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-2.5 flex-wrap mb-5">
        <div>
          <div className="section-label mb-1.5">{campaignName ? `${campaignName} · Ad set` : "Ad set"}</div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-[30px] tracking-tight">{a.name}</h1>
            <span className={clsx("inline-flex items-center gap-1.5",
              a.health === "critical" ? "pill-bad" : a.health === "watch" ? "pill-warn" : "pill-good")}>
              <HealthDot h={a.health} />{a.healthLabel}
            </span>
          </div>
        </div>
        <button onClick={() => router.back()} className="ml-auto btn-ghost"><ArrowLeft size={14} /> Back</button>
      </motion.div>

      {/* KPI heroes */}
      <div className="grid grid-cols-6 gap-3 mb-4">
        <KpiHero i={0} label="Spend" icon={Wallet} rawValue={`${cur}${a.spend.toLocaleString()}`} delta={a.kpiDeltas.spend} deltaTone="neutral" />
        <KpiHero i={1} label="Revenue" icon={DollarSign} rawValue={`${cur}${a.revenue.toLocaleString()}`} delta={a.kpiDeltas.revenue} deltaTone={deltaTone(a.kpiDeltas.revenue, true)} />
        <KpiHero i={2} label="ROAS" icon={Target} rawValue={`${a.roas}x`} delta={a.kpiDeltas.roas} deltaTone={deltaTone(a.kpiDeltas.roas, true)} alert={a.roas < 1.5} />
        <KpiHero i={3} label="CTR" icon={MousePointerClick} rawValue={`${a.ctr}%`} delta={a.kpiDeltas.ctr} deltaTone={deltaTone(a.kpiDeltas.ctr, true)} />
        <KpiHero i={4} label="CPC" icon={Coins} rawValue={`${cur}${a.cpc}`} delta={a.kpiDeltas.cpc} deltaTone={deltaTone(a.kpiDeltas.cpc, false)} />
        <KpiHero i={5} label="Frequency" icon={Repeat} rawValue={String(a.freq)} delta={a.kpiDeltas.freq} deltaTone={a.freq > 6 ? "warn" : "neutral"} alert={a.freq > 8} />
      </div>

      {/* AI insight — promoted above the fold */}
      <div className="mb-4">
        <InsightCard tag={a.insight.tag} title={a.insight.title} body={a.insight.body} defaultOpen />
      </div>

      <div className="grid grid-cols-[1fr_360px] gap-3 mb-5">
        <ChartCard title="CTR & CPA trend" sub="last 7 days" icon={MousePointerClick}>
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="d" tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis yAxisId="l" tick={AXIS_TICK} width={30} axisLine={false} tickLine={false} />
              <YAxis yAxisId="r" orientation="right" tick={AXIS_TICK} width={32} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Line yAxisId="l" dataKey="ctr" stroke="var(--chart1)" strokeWidth={2.5} dot={false} name="CTR %" />
              <Line yAxisId="r" dataKey="cpa" stroke="var(--chart-warn)" strokeWidth={2.5} strokeDasharray="5 3" dot={false} name="CPA $" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Audience block */}
        <div className="card p-4">
          <div className="section-label mb-3">Audience</div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className={clsx("font-display num text-[36px] leading-none", a.freq > 8 ? "text-warn" : a.freq > 5 ? "text-bad" : "text-good")}>{a.freq}</span>
            <span className="text-[11px] font-bold uppercase tracking-wide text-mut">frequency</span>
          </div>
          <div className="h-2 bg-raised rounded-full overflow-hidden mb-3">
            <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(100, a.freq * 10)}%` }} transition={{ duration: 0.8 }}
              className={clsx("h-full rounded-full", a.freq > 8 ? "bg-warn" : a.freq > 5 ? "bg-bad" : "bg-good")} />
          </div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="font-display num text-[36px] leading-none">{a.reachPct}%</span>
            <span className="text-[11px] font-bold uppercase tracking-wide text-mut">audience reached</span>
          </div>
          <div className="h-2 bg-raised rounded-full overflow-hidden mb-3">
            <motion.div initial={{ width: 0 }} animate={{ width: `${a.reachPct}%` }} transition={{ duration: 0.8, delay: 0.15 }}
              className="h-full rounded-full" style={{ background: "var(--hero-grad)" }} />
          </div>
          <p className="text-[12px] text-mut leading-relaxed">{a.note}</p>
        </div>
      </div>

      {/* Creatives */}
      <div className="flex items-center justify-between mb-3">
        <div className="section-label">Creatives — ranked by return</div>
        <span className="text-[12px] text-mut font-medium">{a.ads.length} ads</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {sorted.map((ad, i) => (
          <motion.div key={ad.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }}
            whileHover={{ y: -3 }}
            className={clsx("card overflow-hidden hover:shadow-lift transition-shadow relative",
              ad.rank === "low" && "border-bad/30", ad.rank === "top" && "border-good/30")}>
            <div className="h-24 bg-raised grid place-items-center relative border-b border-line">
              <span className="absolute top-2 left-2 text-[10px] font-bold bg-surface/90 backdrop-blur border border-line rounded-lg px-2 py-0.5 text-mut">{ad.format}</span>
              <span className="absolute top-2 right-2"><RankBadge rank={ad.rank} label={ad.rankLabel} /></span>
              <FmtIcon f={ad.format} />
            </div>
            <div className="p-3.5">
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <span className="font-bold text-[13.5px] truncate">{ad.name}</span>
                <CreativeScore score={creativeScore(ad)} />
              </div>
              <div className="grid grid-cols-3 gap-1.5 mb-3">
                {([["Spend", `${cur}${ad.spend.toLocaleString()}`, ""],
                   ["CTR", `${ad.ctr}%`, ad.ctr > 1.5 ? "text-good" : ad.ctr < 0.8 ? "text-bad" : ""],
                   ["ROAS", `${ad.roas}x`, ad.roas > 3 ? "text-good" : ad.roas < 1.5 ? "text-bad" : ""]] as [string, string, string][]).map(([l, v, cls]) => (
                  <div key={l} className="rounded-lg bg-raised px-2 py-1.5 text-center">
                    <div className={clsx("font-bold text-[13px] num", cls)}>{v}</div>
                    <div className="text-[9px] font-bold uppercase tracking-wide text-mut">{l}</div>
                  </div>
                ))}
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[11px] text-mut font-semibold num">Freq {ad.freq ?? "—"} · {ad.conv} conv</span>
                <ActionPill a={ad.action} />
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
