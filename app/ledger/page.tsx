"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, BookOpen, CheckCircle2, XCircle, Clock } from "lucide-react";
import { recommendations } from "@/lib/data";
import { useDataMode } from "@/components/DataModeProvider";
import { KpiHero } from "@/components/KpiHero";
import PageHeader from "@/components/PageHeader";
import AISummary from "@/components/AISummary";
import clsx from "clsx";

export default function Ledger() {
  // Deployment-level: the previous check read an in-memory store, so reloading
  // this page on a real-data install re-showed the seeded outcome history.
  const { hasRealData } = useDataMode();

  const [filter, setFilter] = useState<"all" | "followed" | "ignored" | "pending">("all");
  const rows = recommendations.filter((r) => filter === "all" || r.status === filter);

  if (hasRealData) {
    return (
      <div className="max-w-5xl mx-auto px-8 py-7">
        <PageHeader kicker="Accountability" title="Recommendation ledger" sub="Nothing recorded for this account yet" />
        <div className="card p-8 text-center">
          <BookOpen size={28} className="mx-auto text-mut mb-3" />
          <div className="font-bold text-[15px] mb-1">No recommendation history yet</div>
          <p className="text-[13px] text-mut max-w-md mx-auto">
            The ledger records each recommendation, whether you followed it, and what measurably
            happened afterwards. That needs recommendations to be issued, acted on, and then
            re-measured against later data — so it stays empty until there is a real outcome to
            report rather than showing an example.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-8 py-7">
      <PageHeader kicker="Accountability" title="Recommendation ledger"
        sub="Every AI recommendation, what you did with it, and what happened after. Proof, not promises."
        right={
          <div className="flex rounded-xl border border-line2 bg-surface p-1">
            {(["all", "followed", "ignored", "pending"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={clsx("relative text-[12px] font-bold px-3 py-1.5 rounded-lg capitalize transition-colors", filter === f ? "text-white" : "text-mut hover:text-ink")}>
                {filter === f && <motion.span layoutId="ledger-pill" className="absolute inset-0 rounded-lg" style={{ background: "var(--hero-grad)" }} transition={{ type: "spring", stiffness: 400, damping: 34 }} />}
                <span className="relative z-10">{f}</span>
              </button>
            ))}
          </div>
        } />

      <AISummary meta="30-day window">
        Your action rate is <strong>64%</strong> and followed recommendations improved their target metric by <strong>+31% on
        average</strong>. Biggest open upside: the frequency cap on <strong>18–34 Female</strong>. The ignored LinkedIn
        recommendation has now cost <strong>~$1,240</strong> — still worth acting on.
      </AISummary>

      <div className="grid grid-cols-4 gap-3 mb-5">
        <KpiHero i={0} label="Recommendations" value={14} sub="last 30 days" />
        <KpiHero i={1} label="Followed" value={9} delta="64% action rate" deltaTone="good" />
        <KpiHero i={2} label="Avg improvement" rawValue="+31%" delta="on followed recs" deltaTone="good" />
        <KpiHero i={3} label="Value recovered" value={4210} prefix="$" sub="this month" delta="↑ this month" deltaTone="good" />
      </div>

      <div className="space-y-2.5">
        <AnimatePresence>
          {rows.map((r) => {
            const StatusIcon = r.status === "followed" ? CheckCircle2 : r.status === "ignored" ? XCircle : Clock;
            const statusColor = r.status === "followed" ? "var(--good)" : r.status === "ignored" ? "var(--bad)" : "var(--warn)";
            return (
              <motion.div key={r.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="card p-4 flex items-center gap-4 relative overflow-hidden">
                <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: statusColor }} />
                <span className="w-10 h-10 rounded-2xl grid place-items-center shrink-0"
                  style={{ background: r.status === "followed" ? "var(--good-soft)" : r.status === "ignored" ? "var(--bad-soft)" : "var(--warn-soft)" }}>
                  <StatusIcon size={18} style={{ color: statusColor }} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-[14px]">{r.title}</span>
                    <span className={r.status === "followed" ? "pill-good" : r.status === "ignored" ? "pill-bad" : "pill-warn"}>
                      {r.status === "followed" ? "Followed" : r.status === "ignored" ? "Ignored" : "Pending"}
                    </span>
                  </div>
                  <div className="text-[12px] text-mut font-medium mt-0.5">{r.evidence} · <span className="text-ink/70">{r.where}</span> · {r.date}{r.actionDate ? ` → acted ${r.actionDate}` : ""}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className={clsx("font-bold text-[15px] num", r.outcomeGood === true ? "text-good" : r.outcomeGood === false ? "text-bad" : "text-mut")}>{r.outcome}</div>
                  <div className="text-[11px] text-mut font-medium">{r.outcomeDetail}</div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {rows.length === 0 && (
          <div className="card p-8 text-center text-[13px] text-mut">No {filter} recommendations.</div>
        )}
      </div>

      <div className="card p-4 mt-5 flex gap-3 items-center">
        <span className="w-8 h-8 rounded-xl grid place-items-center text-white shrink-0" style={{ background: "var(--hero-grad)" }}>
          <Sparkles size={15} />
        </span>
        <p className="text-[13px] leading-relaxed text-mut">The ledger is the trust loop: recommendations carry their evidence at issue time, and outcomes are measured from the same data source afterwards — so you can audit exactly how much following the AI is worth.</p>
      </div>
    </div>
  );
}
