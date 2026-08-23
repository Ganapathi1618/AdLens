"use client";
// Today's Brief.
//
// Two modes, one screen. A pure demo deployment renders the authored CP1 brief
// exactly as before. A deployment holding real data builds the same layout
// from that data: portfolio KPIs from the real campaigns, and the action queue
// from the threshold rules in lib/alerts.ts.
//
// The rule that shapes this file: the brief never states a number nobody
// measured. The seeded copy quotes specific figures ("$1,780/mo is leaking",
// "+$2,500/mo") that are true only of the seeded dataset, so none of it may
// appear beside a real account.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  AlertTriangle, Hourglass, TrendingUp, Search, FileText, BookOpen, ArrowRight,
  DollarSign, Target, MousePointerClick, Wallet, Upload, CheckCircle2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useApp } from "@/lib/store";
import { campaigns as seededCampaigns, type Campaign } from "@/lib/data";
import { KpiHero } from "@/components/KpiHero";
import HealthScore from "@/components/HealthScore";
import AISummary from "@/components/AISummary";
import { sym, commonCurrency, sumByCurrency, formatMixed } from "@/lib/currency";
import { useDataMode } from "@/components/DataModeProvider";
import type { Alert } from "@/lib/alerts";

const stagger = { animate: { transition: { staggerChildren: 0.07 } } };
const item = { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 } };

interface Action {
  icon: typeof AlertTriangle;
  tone: "bad" | "warn" | "good";
  tag: string;
  impact: string;
  title: string;
  body: string;
  href: string;
}

const SEEDED_ACTIONS: Action[] = [
  {
    icon: AlertTriangle, tone: "bad", tag: "Fix now", impact: "−$83/day burning",
    title: "Summer Sale — ROAS below break-even",
    body: "25–44 Male crashed to 1.2x. One fatigued video ad is the culprit.",
    href: "/analysis/summer-sale",
  },
  {
    icon: Hourglass, tone: "warn", tag: "This week", impact: "$4.4k/mo at risk",
    title: "18–34 Female saturating in ~4 days",
    body: "Frequency 8.2, reach 94%. Fresh creative needed before CTR drops.",
    href: "/analysis/summer-sale",
  },
  {
    icon: TrendingUp, tone: "good", tag: "Opportunity", impact: "+$720–1,440/wk",
    title: "Lookalike 1% is ready to scale",
    body: "3.6x ROAS with 59% of the audience untouched.",
    href: "/analysis/summer-sale",
  },
];

export default function Home() {
  const router = useRouter();
  const setCampaign = useApp((s) => s.setCampaign);
  const { hasRealData, uploads } = useDataMode();

  const [real, setReal] = useState<Campaign[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);

  useEffect(() => {
    if (!hasRealData) return;
    fetch("/api/db/campaigns-merged", { cache: "no-store" })
      .then((r) => r.json())
      .then((all: Campaign[]) => setReal(Array.isArray(all) ? all.filter((c) => String(c.id).startsWith("meta_")) : []))
      .catch(() => setReal([]));
    fetch("/api/db/alerts", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setAlerts(Array.isArray(d?.alerts) ? d.alerts : []))
      .catch(() => setAlerts([]));
  }, [hasRealData]);

  // Which campaigns this brief is about. Seeded until real ones arrive.
  const pool: Campaign[] = hasRealData ? real ?? [] : seededCampaigns;
  const active = useMemo(
    () => (hasRealData ? pool.filter((c) => c.status === "Active" || c.spend > 0) : pool.filter((c) => c.status === "Active")),
    [pool, hasRealData]);

  const spend = active.reduce((s, c) => s + c.spend, 0);
  const rev = active.reduce((s, c) => s + c.revenue, 0);
  const roas = spend > 0 ? rev / spend : 0;
  const revenueTracked = rev > 0;

  // Amounts only combine within one currency; a mixed portfolio shows the split.
  const portfolioCur = commonCurrency(active);
  const spendParts = sumByCurrency(active, (c) => c.spend);
  const revParts = sumByCurrency(active, (c) => c.revenue);

  const critical = hasRealData
    ? (alerts ?? []).filter((a) => a.severity === "Critical").length
    : active.filter((c) => c.health === "critical").length;
  const watch = hasRealData
    ? (alerts ?? []).filter((a) => a.severity === "Warning").length
    : active.filter((c) => c.health === "watch").length;

  const healthScore = active.length
    ? Math.max(5, Math.round(100 - (critical / active.length) * 220 - (watch / active.length) * 60))
    : 100;

  const openSummer = () => {
    setCampaign("summer-sale", "Summer Sale — Broad");
    router.push("/analysis/summer-sale");
  };

  // Real actions come from rules that actually fired, with their own evidence.
  const realActions: Action[] = (alerts ?? []).slice(0, 3).map((a) => ({
    icon: a.severity === "Critical" ? AlertTriangle : Hourglass,
    tone: a.severity === "Critical" ? "bad" : "warn",
    tag: a.severity === "Critical" ? "Fix now" : "Watch",
    impact: `${a.value} vs ${a.threshold}`,
    title: `${a.campaign} — ${a.rule}`,
    body: a.detail,
    href: `/analysis/${a.campaignId}`,
  }));
  const actions = hasRealData ? realActions : SEEDED_ACTIONS;

  const waiting = hasRealData && (real === null || alerts === null);
  const headline = waiting
    ? "Reading your data…"
    : !hasRealData
      ? "3 things need you today."
      : actions.length === 0
        ? "Nothing needs you today."
        : `${actions.length} thing${actions.length === 1 ? "" : "s"} need${actions.length === 1 ? "s" : ""} you today.`;

  return (
    <div className="max-w-6xl mx-auto px-8 py-7">
      {/* ── Hero: greeting + portfolio health ─────────────────── */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-end justify-between flex-wrap gap-6 mb-6">
        <div>
          <div className="section-label mb-2">
            {hasRealData
              ? `Daily brief · ${active.length} campaign${active.length === 1 ? "" : "s"} with delivery`
              : "Daily brief · synced 02:00"}
          </div>
          <h1 className="font-display text-[40px] leading-[1.05] tracking-tight">
            Good morning.<br /><span className="gradient-text">{headline}</span>
          </h1>
        </div>
        <div className="card px-5 py-4">
          <HealthScore score={healthScore} label="Portfolio health"
            detail={hasRealData
              ? `${critical} critical · ${watch} warning · ${active.length} campaigns`
              : `${critical} critical · ${watch} watching · ${active.length} active campaigns`} />
        </div>
      </motion.div>

      {/* ── AI Summary ────────────────────────────────────────── */}
      {!hasRealData ? (
        <AISummary meta="reasoning engine · verified figures" cta="Review Summer Sale" onCta={openSummer}>
          Your portfolio returns <strong>{roas.toFixed(1)}x blended</strong>, but <strong>$1,780/mo is leaking</strong> into
          below-break-even adsets. Fixing the fatigued video in Summer Sale and scaling Lookalike 1% would swing
          roughly <strong>+$2,500/mo</strong> — both are one-click actions.
        </AISummary>
      ) : waiting ? null : (
        <AISummary meta="threshold rules · your data only">
          {active.length === 0 ? (
            <>No campaigns have recorded delivery yet. Connect an ad account or upload a report to get a brief.</>
          ) : (
            <>
              {active.length} campaign{active.length === 1 ? "" : "s"} with delivery
              {portfolioCur ? <> spending <strong>{sym(portfolioCur)}{Math.round(spend).toLocaleString()}</strong></> : null}
              {revenueTracked
                ? <> at <strong>{roas.toFixed(2)}x blended</strong></>
                : <>. Revenue is not reported for this data, so efficiency is judged on cost per result rather than ROAS</>}
              .{" "}
              {critical > 0
                ? <>{critical} campaign{critical === 1 ? "" : "s"} crossed a critical threshold — they are first in the queue below.</>
                : watch > 0
                  ? <>Nothing critical; {watch} warning{watch === 1 ? "" : "s"} worth a look below.</>
                  : <>Nothing has crossed a threshold.</>}
            </>
          )}
        </AISummary>
      )}

      {/* ── Portfolio KPIs ────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {portfolioCur
          ? <KpiHero i={0} label="Spend" icon={Wallet} value={spend} prefix={sym(portfolioCur)} sub={hasRealData ? "in this data" : "all active"} />
          : <KpiHero i={0} label="Spend" icon={Wallet} rawValue={formatMixed(spendParts)} sub="across currencies" />}
        {/* Revenue that was never reported is shown as unavailable, not as 0. */}
        {!revenueTracked && hasRealData
          ? <KpiHero i={1} label="Revenue" icon={DollarSign} rawValue="not reported" sub="no conversion value in this data" />
          : portfolioCur
            ? <KpiHero i={1} label="Revenue" icon={DollarSign} value={rev} prefix={sym(portfolioCur)} />
            : <KpiHero i={1} label="Revenue" icon={DollarSign} rawValue={formatMixed(revParts)} sub="across currencies" />}
        {!revenueTracked && hasRealData
          ? <KpiHero i={2} label="Blended ROAS" icon={Target} rawValue="—" sub="needs conversion value" />
          : portfolioCur
            ? <KpiHero i={2} label="Blended ROAS" icon={Target} value={roas} decimals={1} suffix="x" />
            : <KpiHero i={2} label="Blended ROAS" icon={Target} rawValue="—" sub="mixed currencies" />}
        <KpiHero i={3} label={hasRealData ? "Critical alerts" : "Critical campaigns"} icon={MousePointerClick}
          rawValue={String(critical)} delta={`${watch} warning`} deltaTone="bad"
          sub={hasRealData ? "crossed a threshold" : "below break-even"} alert />
      </div>

      {/* ── Action queue ──────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3">
        <div className="section-label">
          {hasRealData ? "Action queue — from your threshold rules" : "Action queue — ranked by impact"}
        </div>
        <Link href={hasRealData ? "/alerts" : "/ledger"}
          className="text-[12px] font-bold text-accent inline-flex items-center gap-1 hover:underline">
          {hasRealData ? <><AlertTriangle size={13} /> See all alerts</> : <><BookOpen size={13} /> Track outcomes in Ledger</>}
        </Link>
      </div>

      {hasRealData && !waiting && actions.length === 0 && (
        <div className="card p-6 mb-7 flex items-start gap-3.5">
          <CheckCircle2 size={20} className="text-good shrink-0 mt-0.5" />
          <div>
            <div className="font-bold text-[14px] mb-0.5">Nothing has crossed a threshold</div>
            <p className="text-[12.5px] text-mut leading-relaxed">
              Every campaign was checked for break-even ROAS, CTR decline, rising cost per result,
              pacing, saturation and stalled delivery. Rules needing a metric your data does not
              contain are skipped rather than counted as passing.
            </p>
          </div>
        </div>
      )}

      {waiting && <div className="card p-6 mb-7 text-[13px] text-mut">Evaluating your campaigns…</div>}

      {actions.length > 0 && (
        <motion.div variants={stagger} initial="initial" animate="animate" className="grid grid-cols-3 gap-3 mb-7">
          {actions.map((a, idx) => {
            const Icon = a.icon;
            const toneColor = a.tone === "bad" ? "var(--bad)" : a.tone === "warn" ? "var(--warn)" : "var(--good)";
            return (
              <motion.button key={idx} variants={item} onClick={() => router.push(a.href)} whileHover={{ y: -4 }}
                className="card p-4 text-left relative overflow-hidden transition-shadow hover:shadow-lift group">
                <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: toneColor }} />
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <span className={a.tone === "bad" ? "pill-bad" : a.tone === "warn" ? "pill-warn" : "pill-good"}>
                    <Icon size={11} /> {a.tag}
                  </span>
                  <span className="text-[11px] font-bold num shrink-0" style={{ color: toneColor }}>{a.impact}</span>
                </div>
                <div className="font-bold text-[14px] leading-snug mb-1 line-clamp-2">{a.title}</div>
                <div className="text-[12px] text-mut leading-relaxed line-clamp-3">{a.body}</div>
                <div className="mt-3 text-[12px] font-bold text-accent inline-flex items-center gap-1">
                  Review <ArrowRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
                </div>
              </motion.button>
            );
          })}
        </motion.div>
      )}

      {/* ── Quick starts ──────────────────────────────────────── */}
      <div className="section-label mb-3">Workflows</div>
      <motion.div variants={stagger} initial="initial" animate="animate" className="grid grid-cols-2 gap-3">
        {[
          { href: "/check", icon: Search, title: "Deep-dive a campaign", body: "Adsets, creatives, frequency, anomalies and AI insights — or compare across platforms." },
          hasRealData && uploads === 0
            ? { href: "/upload", icon: Upload, title: "Upload a report", body: "No account access for a client? Drop in an Ads Manager export and analyse it the same way." }
            : { href: "/reporting", icon: FileText, title: "Generate a client report", body: "Three steps to a client-ready report with charts and an AI narrative that cites your data." },
        ].map(({ href, icon: Icon, title, body }) => (
          <motion.div key={href} variants={item}>
            <Link href={href} className="card card-hover p-5 flex items-center gap-4 group">
              <span className="w-12 h-12 rounded-2xl grid place-items-center text-white shrink-0 shadow-hero"
                style={{ background: "var(--hero-grad)" }}>
                <Icon size={20} />
              </span>
              <div className="flex-1">
                <div className="font-bold text-[15px] mb-0.5">{title}</div>
                <p className="text-[12px] text-mut leading-relaxed">{body}</p>
              </div>
              <ArrowRight size={17} className="text-mut group-hover:text-accent group-hover:translate-x-1 transition-all shrink-0" />
            </Link>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
