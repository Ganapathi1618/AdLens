"use client";
// Today's Brief.
//
// Built entirely from what this deployment actually holds: portfolio KPIs from
// the stored campaigns, and the action queue from the threshold rules in
// lib/alerts.ts, each card carrying the evidence its rule fired on.
//
// The rule that shapes this file: the brief never states a number nobody
// measured. With nothing synced or uploaded it says so and points at the two
// ways in, rather than filling the screen with an example.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  AlertTriangle, Hourglass, Search, FileText, ArrowRight,
  DollarSign, Target, MousePointerClick, Wallet, Upload, CheckCircle2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useApp } from "@/lib/store";
import type { Campaign } from "@/lib/types";
import { KpiHero } from "@/components/KpiHero";
import HealthScore from "@/components/HealthScore";
import AISummary from "@/components/AISummary";
import { sym, commonCurrency, sumByCurrency, formatMixed } from "@/lib/currency";
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

export default function Home() {
  const router = useRouter();
  const setCampaign = useApp((s) => s.setCampaign);

  const [camps, setCamps] = useState<Campaign[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [uploads, setUploads] = useState(0);

  useEffect(() => {
    fetch(`/api/db/accounts?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setCamps(Array.isArray(d?.campaigns) ? d.campaigns : []);
        setUploads((d?.accessibleAccounts ?? []).filter((a: { kind?: string }) => a.kind === "upload").length);
      })
      .catch(() => setCamps([]));
    fetch("/api/db/alerts", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setAlerts(Array.isArray(d?.alerts) ? d.alerts : []))
      .catch(() => setAlerts([]));
  }, []);

  const pool = useMemo(() => camps ?? [], [camps]);
  const active = useMemo(
    () => pool.filter((c) => c.status === "Active" || c.spend > 0), [pool]);

  const spend = active.reduce((s, c) => s + c.spend, 0);
  const rev = active.reduce((s, c) => s + c.revenue, 0);
  const roas = spend > 0 ? rev / spend : 0;
  const revenueTracked = rev > 0;

  // Amounts only combine within one currency; a mixed portfolio shows the split.
  const portfolioCur = commonCurrency(active);
  const spendParts = sumByCurrency(active, (c) => c.spend);
  const revParts = sumByCurrency(active, (c) => c.revenue);

  const critical = (alerts ?? []).filter((a) => a.severity === "Critical").length;
  const watch = (alerts ?? []).filter((a) => a.severity === "Warning").length;

  const healthScore = active.length
    ? Math.max(5, Math.round(100 - (critical / active.length) * 220 - (watch / active.length) * 60))
    : 100;

  // Actions come from rules that actually fired, each with its own evidence.
  const actions: Action[] = (alerts ?? []).slice(0, 3).map((a) => ({
    icon: a.severity === "Critical" ? AlertTriangle : Hourglass,
    tone: a.severity === "Critical" ? "bad" : "warn",
    tag: a.severity === "Critical" ? "Fix now" : "Watch",
    impact: `${a.value} vs ${a.threshold}`,
    title: `${a.campaign} — ${a.rule}`,
    body: a.detail,
    href: `/analysis/${a.campaignId}`,
  }));

  const waiting = camps === null || alerts === null;

  // ── nothing brought in yet ───────────────────────────────────────
  if (!waiting && pool.length === 0) {
    return (
      <div className="max-w-6xl mx-auto px-8 py-7">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-7">
          <div className="section-label mb-2">Daily brief</div>
          <h1 className="font-display text-[40px] leading-[1.05] tracking-tight">
            Welcome to AdLens.<br /><span className="gradient-text">Bring in your first campaign.</span>
          </h1>
          <p className="text-[13px] text-mut mt-3 max-w-lg leading-relaxed">
            AdLens analyses what your ad account actually reported. Connect an account to
            sync it, or upload an Ads Manager export if you would rather not grant access.
          </p>
        </motion.div>
        <motion.div variants={stagger} initial="initial" animate="animate" className="grid grid-cols-2 gap-3">
          {[
            { href: "/check", icon: Search, title: "Connect an ad account", body: "Grant access with Facebook, pick the accounts to share, and sync campaigns, ad sets and ads." },
            { href: "/upload", icon: Upload, title: "Upload a report", body: "Drop in a .csv or .xlsx export from Ads Manager. No credentials, same analysis." },
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

  const headline = waiting
    ? "Reading your data…"
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
            Daily brief · {active.length} campaign{active.length === 1 ? "" : "s"} with delivery
          </div>
          <h1 className="font-display text-[40px] leading-[1.05] tracking-tight">
            Good morning.<br /><span className="gradient-text">{headline}</span>
          </h1>
        </div>
        <div className="card px-5 py-4">
          <HealthScore score={healthScore} label="Portfolio health"
            detail={`${critical} critical · ${watch} warning · ${active.length} campaigns`} />
        </div>
      </motion.div>

      {/* ── AI Summary ────────────────────────────────────────── */}
      {!waiting && (
        <AISummary meta="threshold rules · your data only">
          {active.length === 0 ? (
            <>No campaigns have recorded delivery yet. Sync an account or upload a report to get a brief.</>
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
          ? <KpiHero i={0} label="Spend" icon={Wallet} value={spend} prefix={sym(portfolioCur)} sub="in this data" />
          : <KpiHero i={0} label="Spend" icon={Wallet} rawValue={formatMixed(spendParts)} sub="across currencies" />}
        {/* Revenue that was never reported is shown as unavailable, not as 0. */}
        {!revenueTracked
          ? <KpiHero i={1} label="Revenue" icon={DollarSign} rawValue="not reported" sub="no conversion value in this data" />
          : portfolioCur
            ? <KpiHero i={1} label="Revenue" icon={DollarSign} value={rev} prefix={sym(portfolioCur)} />
            : <KpiHero i={1} label="Revenue" icon={DollarSign} rawValue={formatMixed(revParts)} sub="across currencies" />}
        {!revenueTracked
          ? <KpiHero i={2} label="Blended ROAS" icon={Target} rawValue="—" sub="needs conversion value" />
          : portfolioCur
            ? <KpiHero i={2} label="Blended ROAS" icon={Target} value={roas} decimals={1} suffix="x" />
            : <KpiHero i={2} label="Blended ROAS" icon={Target} rawValue="—" sub="mixed currencies" />}
        <KpiHero i={3} label="Critical alerts" icon={MousePointerClick}
          rawValue={String(critical)} delta={`${watch} warning`} deltaTone="bad"
          sub="crossed a threshold" alert />
      </div>

      {/* ── Action queue ──────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3">
        <div className="section-label">Action queue — from your threshold rules</div>
        <Link href="/alerts" className="text-[12px] font-bold text-accent inline-flex items-center gap-1 hover:underline">
          <AlertTriangle size={13} /> See all alerts
        </Link>
      </div>

      {!waiting && actions.length === 0 && (
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
          { href: "/check", icon: Search, title: "Deep-dive a campaign", body: "Ad sets, creatives, frequency, anomalies and AI insights grounded in your own data." },
          uploads === 0
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
