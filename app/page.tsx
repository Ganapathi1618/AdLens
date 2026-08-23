"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle, Search, FileText, BookOpen, ArrowRight, Upload,
  DollarSign, Target, MousePointerClick, Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useApp } from "@/lib/store";
import type { Campaign } from "@/lib/types";
import { KpiHero } from "@/components/KpiHero";
import HealthScore from "@/components/HealthScore";
import { sym, commonCurrency, sumByCurrency, formatMixed } from "@/lib/currency";

const stagger = { animate: { transition: { staggerChildren: 0.07 } } };
const item = { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 } };

export default function Home() {
  const router = useRouter();
  const setCampaign = useApp((s) => s.setCampaign);

  // The brief is built from what is actually stored — synced from Meta or
  // uploaded from a report. There is no portfolio to summarise until one of
  // those has happened, and none is invented in the meantime.
  const [camps, setCamps] = useState<Campaign[] | null>(null);
  useEffect(() => {
    fetch(`/api/db/accounts?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setCamps(Array.isArray(d?.campaigns) ? d.campaigns : []))
      .catch(() => setCamps([]));
  }, []);

  const open = (c: Campaign) => { setCampaign(c.id, c.name); router.push(`/analysis/${c.id}`); };

  const active = (camps ?? []).filter((c) => c.status === "Active");
  const spend = active.reduce((s, c) => s + c.spend, 0);
  const rev = active.reduce((s, c) => s + c.revenue, 0);
  const roas = spend > 0 ? rev / spend : 0;
  // Only combine money when every active campaign reports the same currency.
  const portfolioCur = commonCurrency(active);
  const spendParts = sumByCurrency(active, (c) => c.spend);
  const revParts = sumByCurrency(active, (c) => c.revenue);
  const critical = active.filter((c) => c.health === "critical").length;
  const watch = active.filter((c) => c.health === "watch").length;
  const healthScore = active.length
    ? Math.max(5, Math.round(100 - (critical / active.length) * 220 - (watch / active.length) * 60))
    : 0;

  // Ranked by what the rules found, worst first — never by an invented impact.
  const needsAttention = active
    .filter((c) => c.health === "critical" || c.health === "watch")
    .sort((a, b) => (a.health === "critical" ? 0 : 1) - (b.health === "critical" ? 0 : 1) || b.spend - a.spend)
    .slice(0, 3);

  if (camps === null) {
    return <div className="max-w-6xl mx-auto px-8 py-7 text-[13px] text-mut">Loading your portfolio…</div>;
  }

  if (camps.length === 0) {
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

  return (
    <div className="max-w-6xl mx-auto px-8 py-7">
      {/* ── Hero: greeting + portfolio health ─────────────────── */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-end justify-between flex-wrap gap-6 mb-6">
        <div>
          <div className="section-label mb-2">Daily brief</div>
          <h1 className="font-display text-[40px] leading-[1.05] tracking-tight">
            Good morning.<br />
            <span className="gradient-text">
              {needsAttention.length === 0
                ? "Nothing needs you today."
                : `${needsAttention.length} thing${needsAttention.length === 1 ? "" : "s"} need${needsAttention.length === 1 ? "s" : ""} you today.`}
            </span>
          </h1>
        </div>
        <div className="card px-5 py-4">
          <HealthScore score={healthScore} label="Portfolio health"
            detail={`${critical} critical · ${watch} watching · ${active.length} active campaigns`} />
        </div>
      </motion.div>

      {/* ── Portfolio KPIs ────────────────────────────────────── */}
      {/* Amounts only combine within one currency; a mixed portfolio shows the
          split rather than a meaningless sum. */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {portfolioCur
          ? <KpiHero i={0} label="Spend" icon={Wallet} value={spend} prefix={sym(portfolioCur)} sub="all active" />
          : <KpiHero i={0} label="Spend" icon={Wallet} rawValue={formatMixed(spendParts)} sub="across currencies" />}
        {portfolioCur
          ? <KpiHero i={1} label="Revenue" icon={DollarSign} value={rev} prefix={sym(portfolioCur)} />
          : <KpiHero i={1} label="Revenue" icon={DollarSign} rawValue={formatMixed(revParts)} sub="across currencies" />}
        {portfolioCur
          ? <KpiHero i={2} label="Blended ROAS" icon={Target} value={roas} decimals={1} suffix="x" />
          : <KpiHero i={2} label="Blended ROAS" icon={Target} rawValue="—" sub="mixed currencies" />}
        <KpiHero i={3} label="Critical campaigns" icon={MousePointerClick} rawValue={String(critical)}
          delta={`${watch} watching`} deltaTone="bad" sub="below break-even" alert />
      </div>

      {/* ── Action queue ──────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3">
        <div className="section-label">Needs attention</div>
        <Link href="/ledger" className="text-[12px] font-bold text-accent inline-flex items-center gap-1 hover:underline">
          <BookOpen size={13} /> Track outcomes in Ledger
        </Link>
      </div>
      {needsAttention.length === 0 ? (
        <div className="card p-6 text-[13px] text-mut mb-7">
          No campaign is currently flagged critical or watch. Open any campaign from{" "}
          <Link href="/overview" className="text-accent font-bold">Campaigns</Link> for its full analysis.
        </div>
      ) : (
        <motion.div variants={stagger} initial="initial" animate="animate" className="grid grid-cols-3 gap-3 mb-7">
          {needsAttention.map((c) => {
            const bad = c.health === "critical";
            const toneColor = bad ? "var(--bad)" : "var(--warn)";
            return (
              <motion.button key={c.id} variants={item} onClick={() => open(c)} whileHover={{ y: -4 }}
                className="card p-4 text-left relative overflow-hidden transition-shadow hover:shadow-lift group">
                <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: toneColor }} />
                <div className="flex items-center justify-between mb-2.5">
                  <span className={bad ? "pill-bad" : "pill-warn"}>
                    <AlertTriangle size={11} /> {bad ? "Critical" : "Watch"}
                  </span>
                  <span className="text-[11px] font-bold num" style={{ color: toneColor }}>
                    {sym(c.currency)}{c.spend.toLocaleString()}
                  </span>
                </div>
                <div className="font-bold text-[14px] leading-snug mb-1">{c.name}</div>
                <div className="text-[12px] text-mut leading-relaxed">
                  {c.roas > 0 ? `ROAS ${c.roas}x` : "Revenue not reported"} · CTR {c.ctr}% · {c.objective}
                </div>
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
          { href: "/reporting", icon: FileText, title: "Generate a client report", body: "Three steps to a client-ready report with charts and an AI narrative that cites your data." },
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
