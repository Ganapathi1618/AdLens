"use client";
// Month-over-month report.
//
// Pick a source and two calendar months, get a client-ready comparison:
// portfolio deltas, the campaigns that moved most, and the ones that started
// or stopped. Printable straight to PDF.
//
// The screen states its own limits rather than hiding them — which months are
// partial, whether the two were cut to the same span, and which metrics the
// data does not contain. A month-over-month number that quietly compares 18
// days against 31 is worse than no number.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  CalendarRange, Download, Upload, ArrowRight, TrendingUp, TrendingDown,
  AlertTriangle, Plus, Minus, Info,
} from "lucide-react";
import clsx from "clsx";
import PageHeader from "@/components/PageHeader";
import { money, moneyShort } from "@/lib/currency";
import type { MonthlyReport, CampaignMonthDelta } from "@/lib/monthly";
import type { MetricChange } from "@/lib/periods";

interface AccountRow {
  id: string;
  name: string;
  kind?: "graph" | "upload";
  upload?: { filename: string; campaigns: number };
}

interface Report extends MonthlyReport {
  account: { id: string; name: string; kind: string; sources: { filename: string; dateStart: string | null; dateEnd: string | null }[] };
  evaluated: number;
  totalCampaigns: number;
  truncated?: boolean;
}

interface Failure {
  error: string;
  available?: { key: string; label: string }[];
  needsMoreData?: boolean;
}

const pctText = (c: MetricChange | null) =>
  c?.changePct == null ? "—" : `${c.changePct > 0 ? "+" : c.changePct < 0 ? "−" : ""}${Math.abs(c.changePct).toFixed(1)}%`;

const toneOf = (c: MetricChange | null) =>
  c?.better === true ? "text-good" : c?.better === false ? "text-bad" : "text-mut";

export default function Monthly() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [account, setAccount] = useState<string>("");
  const [current, setCurrent] = useState<string>("");
  const [previous, setPrevious] = useState<string>("");
  const [align, setAlign] = useState<"auto" | "full" | "same-days">("auto");
  const [report, setReport] = useState<Report | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(true);

  // Which sources can be reported on: uploaded batches and any connected account.
  useEffect(() => {
    fetch("/api/db/accounts", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const rows: AccountRow[] = d?.accessibleAccounts ?? [];
        setAccounts(rows);
        setAccount((a) => a || rows[0]?.id || "");
        if (!rows.length) setLoading(false);
      })
      .catch(() => { setAccounts([]); setLoading(false); });
  }, []);

  const load = useCallback((acct: string, cur?: string, prev?: string, alignment?: string) => {
    if (!acct) return;
    setLoading(true);
    setFailure(null);
    const qs = new URLSearchParams({ account: acct, t: String(Date.now()) });
    if (cur) qs.set("current", cur);
    if (prev) qs.set("previous", prev);
    if (alignment && alignment !== "auto") qs.set("align", alignment);
    fetch(`/api/db/monthly?${qs}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw Object.assign(new Error(d?.error ?? "Could not build the report."), { data: d });
        return d as Report;
      })
      .then((d) => {
        setReport(d);
        setCurrent(d.comparison.current.key);
        setPrevious(d.comparison.previous.key);
      })
      .catch((e: unknown) => {
        setReport(null);
        const data = (e as { data?: Failure }).data;
        setFailure({ error: e instanceof Error ? e.message : "Could not build the report.", ...data });
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (account) load(account); }, [account, load]);

  const rerun = (next: Partial<{ current: string; previous: string; align: string }>) => {
    const c = next.current ?? current;
    const p = next.previous ?? previous;
    const a = next.align ?? align;
    if (next.current) setCurrent(next.current);
    if (next.previous) setPrevious(next.previous);
    if (next.align) setAlign(next.align as typeof align);
    load(account, c, p, a);
  };

  const cur = report?.comparison.current;
  const prev = report?.comparison.previous;
  const currency = report?.currency ?? "USD";

  const headline = useMemo(() => {
    if (!report || !cur || !prev) return null;
    return report.comparison.changes.find((c) => c.metric === "Cost per result")?.changePct != null
      ? report.comparison.changes.find((c) => c.metric === "Cost per result")!
      : report.comparison.changes.find((c) => c.metric === "ROAS") ?? null;
  }, [report, cur, prev]);

  return (
    <div className="max-w-5xl mx-auto px-8 py-7 print:p-0 print:max-w-none">
      <div className="print:hidden">
        <PageHeader kicker="Reports" title="Month over month"
          sub="Compare two calendar months across every campaign in an account — from a connected account or from reports you upload." />
      </div>

      {/* ── source + months ─────────────────────────────────────── */}
      <div className="card p-4 mb-5 print:hidden">
        <div className="grid gap-3 md:grid-cols-[1.6fr_1fr_1fr]">
          <label className="block">
            <span className="section-label block mb-1.5">Account or uploaded report</span>
            <select value={account} onChange={(e) => { setAccount(e.target.value); setReport(null); }}
              className="w-full text-[13px] font-semibold px-3 py-2.5 rounded-xl border border-line2 bg-surface outline-none focus:border-accent">
              {accounts.length === 0 && <option value="">No sources yet</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.kind === "upload" ? `Uploaded · ${a.name}` : a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="section-label block mb-1.5">This month</span>
            <select value={current} disabled={!report} onChange={(e) => rerun({ current: e.target.value })}
              className="w-full text-[13px] font-semibold px-3 py-2.5 rounded-xl border border-line2 bg-surface outline-none focus:border-accent disabled:opacity-50">
              {(report?.available ?? []).map((m) => (
                <option key={m.key} value={m.key}>{m.label}{m.complete ? "" : ` (${m.daysWithData}d)`}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="section-label block mb-1.5">Compared with</span>
            <select value={previous} disabled={!report} onChange={(e) => rerun({ previous: e.target.value })}
              className="w-full text-[13px] font-semibold px-3 py-2.5 rounded-xl border border-line2 bg-surface outline-none focus:border-accent disabled:opacity-50">
              {(report?.available ?? []).map((m) => (
                <option key={m.key} value={m.key}>{m.label}{m.complete ? "" : ` (${m.daysWithData}d)`}</option>
              ))}
            </select>
          </label>
        </div>

        {report && (
          <div className="flex items-center justify-between gap-3 flex-wrap mt-3 pt-3 border-t border-line">
            <div className="flex items-center gap-1.5">
              <span className="text-[11.5px] text-mut font-semibold mr-1">Compare</span>
              {([
                ["auto", "Automatic"],
                ["same-days", "Same day span"],
                ["full", "Whole months"],
              ] as const).map(([k, label]) => (
                <button key={k} onClick={() => rerun({ align: k })}
                  className={clsx("text-[11.5px] font-bold px-2.5 py-1.5 rounded-lg border transition-colors",
                    align === k ? "border-accent text-accent" : "border-line2 text-mut hover:text-ink")}
                  style={align === k ? { background: "var(--accent-soft)" } : undefined}>
                  {label}
                </button>
              ))}
            </div>
            <button onClick={() => window.print()} className="btn-primary !py-1.5 !text-[12px]">
              <Download size={13} /> Export PDF
            </button>
          </div>
        )}
      </div>

      {/* ── not enough data ─────────────────────────────────────── */}
      {failure && (
        <div className="card p-6 mb-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-warn shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-bold text-[14.5px] mb-1">
                {failure.needsMoreData ? "One month is not a comparison" : "Could not build the report"}
              </div>
              <p className="text-[13px] text-mut leading-relaxed mb-3">{failure.error}</p>
              {failure.needsMoreData && (
                <>
                  <p className="text-[12.5px] text-mut leading-relaxed mb-3">
                    Upload an export covering another month and choose <strong className="text-ink">Add to
                    an existing report</strong> so both months live together. Replacing would discard the
                    month you already have.
                  </p>
                  <Link href="/upload" className="btn-primary !py-1.5 !text-[12px]">
                    <Upload size={13} /> Add another month
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {loading && !report && !failure && (
        <div className="card p-8 text-center text-[13px] text-mut">Building the comparison…</div>
      )}

      {/* ── the report ──────────────────────────────────────────── */}
      {report && cur && prev && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="card p-6 mb-5 print:border-0 print:shadow-none print:p-0">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
              <div>
                <div className="section-label mb-1">{report.account.name}</div>
                <h2 className="font-display text-[26px] leading-tight tracking-tight">
                  {cur.label} <span className="text-mut">vs</span> {prev.label}
                </h2>
              </div>
              <div className="text-right">
                <div className="text-[11.5px] text-mut font-semibold">
                  {report.comparison.alignedTo
                    ? `days 1–${report.comparison.alignedTo} of each month`
                    : "whole months"}
                </div>
                <div className="text-[11.5px] text-mut">
                  {report.evaluated} campaign{report.evaluated === 1 ? "" : "s"}
                  {report.truncated ? ` of ${report.totalCampaigns}` : ""}
                </div>
              </div>
            </div>

            {headline?.changePct != null && (
              <p className="text-[13.5px] leading-relaxed mt-3">
                Across {report.evaluated} campaigns, <strong>{headline.metric.toLowerCase()}</strong> moved{" "}
                <strong className={toneOf(headline)}>{pctText(headline)}</strong>{" "}
                {headline.better === true ? "in your favour" : headline.better === false ? "against you" : ""} versus {prev.label}.
              </p>
            )}
          </div>

          {/* portfolio metrics */}
          <div className="section-label mb-2">Portfolio</div>
          <div className="card overflow-hidden mb-5">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="px-4 py-2.5 font-bold">Metric</th>
                    <th className="px-4 py-2.5 font-bold text-right">{cur.label}</th>
                    <th className="px-4 py-2.5 font-bold text-right">{prev.label}</th>
                    <th className="px-4 py-2.5 font-bold text-right">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.comparison.changes.map((c) => {
                    const isMoney = ["Spend", "Revenue", "Cost per result", "CPC"].includes(c.metric);
                    const fmt = (v: number | null) =>
                      v == null ? <span className="text-mut">not reported</span>
                        : isMoney ? money(v, currency)
                          : c.metric === "ROAS" ? `${v.toFixed(2)}x`
                            : c.metric === "CTR" ? `${v.toFixed(2)}%`
                              : v.toLocaleString();
                    return (
                      <tr key={c.metric}>
                        <td className="px-4 py-2.5 font-semibold">{c.metric}</td>
                        <td className="px-4 py-2.5 text-right num">{fmt(c.current)}</td>
                        <td className="px-4 py-2.5 text-right num text-mut">{fmt(c.previous)}</td>
                        <td className={clsx("px-4 py-2.5 text-right num font-bold", toneOf(c))}>{pctText(c)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* movers */}
          <div className="grid md:grid-cols-2 gap-3 mb-5">
            <MoverList title="Biggest improvements" icon={TrendingUp} tone="good"
              rows={report.improved} currency={currency}
              empty="No campaign improved measurably." />
            <MoverList title="Biggest declines" icon={TrendingDown} tone="bad"
              rows={report.declined} currency={currency}
              empty="No campaign declined measurably." />
          </div>

          {/* started / stopped */}
          {(report.started.length > 0 || report.stopped.length > 0) && (
            <div className="grid md:grid-cols-2 gap-3 mb-5">
              {report.started.length > 0 && (
                <ChangeList title={`Started in ${cur.label}`} icon={Plus} rows={report.started}
                  currency={currency} field="current" />
              )}
              {report.stopped.length > 0 && (
                <ChangeList title={`Stopped after ${prev.label}`} icon={Minus} rows={report.stopped}
                  currency={currency} field="previous" />
              )}
            </div>
          )}

          {/* every campaign */}
          <div className="section-label mb-2">Every campaign, by spend change</div>
          <div className="card overflow-hidden mb-5">
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto print:max-h-none">
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0" style={{ background: "var(--surface)" }}>
                  <tr className="border-b border-line text-left">
                    <th className="px-4 py-2.5 font-bold">Campaign</th>
                    <th className="px-4 py-2.5 font-bold text-right">Spend {cur.label.split(" ")[0]}</th>
                    <th className="px-4 py-2.5 font-bold text-right">Spend {prev.label.split(" ")[0]}</th>
                    <th className="px-4 py-2.5 font-bold text-right">Δ Spend</th>
                    <th className="px-4 py-2.5 font-bold text-right">Efficiency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.campaigns.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-2.5 max-w-[300px]">
                        <Link href={`/analysis/${c.id}`} className="font-semibold hover:text-accent truncate block" title={c.name}>
                          {c.name}
                        </Link>
                        {c.trend !== "continuing" && (
                          <span className="pill-mut mt-1">{c.trend === "started" ? "started" : "stopped"}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right num">{moneyShort(c.current.spend, currency)}</td>
                      <td className="px-4 py-2.5 text-right num text-mut">{moneyShort(c.previous.spend, currency)}</td>
                      <td className={clsx("px-4 py-2.5 text-right num font-semibold", c.spendDelta > 0 ? "text-ink" : "text-mut")}>
                        {c.spendDelta > 0 ? "+" : c.spendDelta < 0 ? "−" : ""}{moneyShort(Math.abs(c.spendDelta), currency)}
                      </td>
                      <td className={clsx("px-4 py-2.5 text-right num font-semibold", toneOf(c.efficiency))}>
                        {c.efficiency ? pctText(c.efficiency) : <span className="text-mut">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* caveats — always last, never hidden */}
          {report.caveats.length > 0 && (
            <div className="card p-4 mb-5">
              <div className="flex items-start gap-2.5">
                <Info size={15} className="text-accent shrink-0 mt-0.5" />
                <div>
                  <div className="section-label mb-1.5">How to read this</div>
                  <ul className="space-y-1.5">
                    {report.caveats.map((c, i) => (
                      <li key={i} className="text-[12.5px] text-mut leading-relaxed">{c}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {report.account.sources.length > 0 && (
            <div className="text-[11.5px] text-mut leading-relaxed">
              Built from {report.account.sources.length} uploaded file
              {report.account.sources.length === 1 ? "" : "s"}:{" "}
              {report.account.sources.map((s) => `${s.filename} (${s.dateStart} → ${s.dateEnd})`).join(", ")}.
            </div>
          )}
        </motion.div>
      )}

      {accounts.length === 0 && !loading && (
        <div className="card p-8 text-center print:hidden">
          <CalendarRange size={28} className="mx-auto text-mut mb-3" />
          <div className="font-bold text-[15px] mb-1">Nothing to compare yet</div>
          <p className="text-[13px] text-mut max-w-md mx-auto mb-4">
            Connect an ad account, or upload two monthly exports into one report, and this page
            will compare them.
          </p>
          <Link href="/upload" className="btn-primary"><Upload size={14} /> Upload a report</Link>
        </div>
      )}
    </div>
  );
}

function MoverList({ title, icon: Icon, tone, rows, currency, empty }: {
  title: string; icon: typeof TrendingUp; tone: "good" | "bad";
  rows: CampaignMonthDelta[]; currency: string; empty: string;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 mb-2.5">
        <Icon size={14} className={tone === "good" ? "text-good" : "text-bad"} />
        <span className="section-label">{title}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-mut">{empty}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => (
            <div key={c.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/analysis/${c.id}`} className="text-[12.5px] font-semibold truncate block hover:text-accent" title={c.name}>
                  {c.name}
                </Link>
                <div className="text-[11px] text-mut">
                  {c.efficiency?.metric} · {moneyShort(c.current.spend, currency)} spend
                </div>
              </div>
              <span className={clsx("text-[13px] font-bold num shrink-0", tone === "good" ? "text-good" : "text-bad")}>
                {pctText(c.efficiency)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChangeList({ title, icon: Icon, rows, currency, field }: {
  title: string; icon: typeof Plus; rows: CampaignMonthDelta[];
  currency: string; field: "current" | "previous";
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 mb-2.5">
        <Icon size={14} className="text-accent" />
        <span className="section-label">{title} ({rows.length})</span>
      </div>
      <div className="space-y-1.5 max-h-[180px] overflow-y-auto print:max-h-none">
        {rows.slice(0, 20).map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3">
            <Link href={`/analysis/${c.id}`} className="text-[12.5px] font-semibold truncate hover:text-accent" title={c.name}>
              {c.name}
            </Link>
            <span className="text-[12px] num text-mut shrink-0">{moneyShort(c[field].spend, currency)}</span>
          </div>
        ))}
        {rows.length > 20 && <div className="text-[11px] text-mut pt-1">+{rows.length - 20} more</div>}
      </div>
    </div>
  );
}
