"use client";
// Alerts.
//
// Evaluated on request against the daily metrics actually stored for this
// account (lib/alerts.ts). A rule whose metric the data lacks is skipped, not
// reported as passing, and nothing is shown that the data did not produce.

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Bell, ArrowRight, CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import clsx from "clsx";
import type { Alert } from "@/lib/alerts";

interface AlertResponse {
  alerts: Alert[];
  evaluated: number;
  campaigns: number;
  truncated?: boolean;
  error?: string;
}

export default function Alerts() {
  const router = useRouter();

  const [data, setData] = useState<AlertResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch("/api/db/alerts", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error ?? "Could not evaluate alerts.");
        return d as AlertResponse;
      })
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not evaluate alerts."))
      .finally(() => setLoading(false));
  }, []);

  const list = data?.alerts ?? [];
  const critical = list.filter((a) => a.severity === "Critical");
  const warning = list.filter((a) => a.severity === "Warning");

  return (
    <div className="max-w-5xl mx-auto px-8 py-7">
      <PageHeader kicker="Monitoring" title="Alerts"
        sub={loading
          ? "Evaluating rules against your stored metrics…"
          : error
            ? "Could not evaluate rules"
            : <><span className={clsx("font-bold", critical.length ? "text-bad" : "text-mut")}>{critical.length} critical</span>
                {" · "}{warning.length} warning · {data?.evaluated ?? 0} campaigns evaluated</>} />

      {error && (
        <div className="card p-4 mb-4 border-bad/40 text-[13px] font-semibold text-bad">{error}</div>
      )}

      {loading && (
        <div className="card p-8 text-center text-[13px] text-mut">Evaluating thresholds…</div>
      )}

      {!loading && !error && list.length === 0 && (
        <div className="card p-8 text-center">
          <CheckCircle2 size={28} className="mx-auto text-good mb-3" />
          <div className="font-bold text-[15px] mb-1">Nothing has crossed a threshold</div>
          <p className="text-[13px] text-mut max-w-md mx-auto">
            {data?.evaluated ?? 0} campaigns were checked for break-even ROAS, CTR decline, rising cost
            per result, pacing, saturation and stalled delivery. Rules that need a metric your data
            does not contain are skipped rather than reported as passing.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {list.map((a, i) => {
          const isCrit = a.severity === "Critical";
          return (
            <motion.button key={a.id} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(i, 8) * 0.05 }}
              onClick={() => router.push(`/analysis/${a.campaignId}`)}
              className={clsx("card w-full p-4 flex items-center gap-4 text-left card-hover relative overflow-hidden", isCrit && "border-bad/30")}>
              <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: isCrit ? "var(--bad)" : "var(--warn)" }} />
              <span className="w-11 h-11 rounded-2xl grid place-items-center shrink-0"
                style={{ background: isCrit ? "var(--bad-soft)" : "var(--warn-soft)" }}>
                <AlertTriangle size={19} className={isCrit ? "text-bad" : "text-warn"} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <span className={isCrit ? "pill-bad" : "pill-warn"}>{a.severity}</span>
                  <span className="font-bold text-[15px] truncate max-w-[420px]" title={a.campaign}>{a.campaign}</span>
                  <span className="text-[12px] text-mut font-medium">· {a.window}d of data</span>
                </div>
                <div className="text-[13px] font-semibold">{a.rule}</div>
                <div className="text-[12px] text-mut font-medium leading-snug mt-0.5">{a.detail}</div>
              </div>
              <div className="text-right shrink-0 mr-2">
                <div className={clsx("font-display num text-[24px] leading-none", isCrit ? "text-bad" : "text-warn")}>{a.value}</div>
                <div className="text-[11px] text-mut font-semibold mt-1">threshold {a.threshold}</div>
              </div>
              <ArrowRight size={17} className="text-mut shrink-0" />
            </motion.button>
          );
        })}
      </div>

      {!loading && (
        <div className="card p-4 mt-5 flex items-start gap-3">
          <Bell size={16} className="text-accent shrink-0 mt-0.5" />
          <p className="text-[12.5px] text-mut leading-relaxed">
            Rules are evaluated on every visit from the metrics stored for this account — no background
            job, so what you see is current with your data rather than with a schedule.
            {data?.truncated && ` Only the ${data.evaluated} highest-spending of ${data.campaigns} campaigns are evaluated.`}
            {" "}Thresholds are fixed for now; making them editable per account is the next step.
          </p>
        </div>
      )}
    </div>
  );
}
