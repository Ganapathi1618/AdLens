"use client";
import { BookOpen, Sparkles } from "lucide-react";
import PageHeader from "@/components/PageHeader";

// The ledger is the trust loop: every recommendation is recorded with the
// evidence it was issued on, and its outcome is measured from the same data
// afterwards. That history accumulates from real recommendations on real
// campaigns — there is no starting balance to show.
export default function Ledger() {
  return (
    <div className="max-w-5xl mx-auto px-8 py-7">
      <PageHeader kicker="Accountability" title="Recommendation ledger"
        sub="Every AI recommendation, what you did with it, and what happened after." />

      <div className="card p-8 text-center">
        <BookOpen size={28} className="mx-auto text-mut mb-3" />
        <div className="font-bold text-[15px] mb-1">No recommendation history yet</div>
        <p className="text-[13px] text-mut max-w-md mx-auto">
          Entries appear once recommendations have been issued from your campaign
          analysis and acted on. Each one keeps the evidence it was issued with, so
          its outcome can be measured against the same data later.
        </p>
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
