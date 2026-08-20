"use client";
// ── Upload a report ─────────────────────────────────────────────────
// The screen's real job is not "accept a file" — it is to make sure the user
// knows, BEFORE committing, exactly what their export can and cannot support.
// A campaign-level monthly export produces a KPI strip and nothing else, and a
// user who finds that out after the fact concludes the product is thin. So the
// preview names the tier, lists every capability with the reason it is on or
// off, and only then offers Commit.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, FileSpreadsheet, Check, X, AlertTriangle, Trash2, ArrowRight, Info } from "lucide-react";
import clsx from "clsx";
import PageHeader from "@/components/PageHeader";
import { FIELD_SPECS, TIER_LABEL, TIER_BLURB, type ReportAnalysis, type Field, type Mapping } from "@/lib/reportFields";
import type { UploadBatch } from "@/lib/uploads";
import { money } from "@/lib/currency";

interface Campaign { id: string; name: string; spend: number; roas: number }

const TIER_TONE: Record<string, string> = {
  full: "text-good border-good/40",
  trends: "text-accent border-accent/40",
  snapshot: "text-warn border-warn/40",
};

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<ReportAnalysis | null>(null);
  const [overrides, setOverrides] = useState<Mapping>({});
  const [busy, setBusy] = useState<null | "preview" | "commit">(null);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<UploadBatch | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [batches, setBatches] = useState<UploadBatch[]>([]);
  const [label, setLabel] = useState("");
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const timezone = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
  }, []);

  const refreshBatches = useCallback(() => {
    fetch("/api/upload", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setBatches(d.batches ?? []))
      .catch(() => setBatches([]));
  }, []);
  useEffect(() => { refreshBatches(); }, [refreshBatches]);

  /** The mapping the user has actually confirmed: detection plus their edits. */
  const effectiveMapping: Mapping = useMemo(
    () => ({ ...(analysis?.mapping ?? {}), ...overrides }),
    [analysis, overrides]);

  async function preview(f: File, mapping?: Mapping) {
    setBusy("preview");
    setError(null);
    setCommitted(null);
    try {
      const body = new FormData();
      body.append("file", f);
      if (mapping) body.append("mapping", JSON.stringify(mapping));
      const res = await fetch("/api/upload?mode=preview", { method: "POST", body });
      const d = await res.json();
      if (d.analysis) setAnalysis(d.analysis);
      if (!res.ok && !d.analysis) throw new Error(d.error ?? "Could not read that file.");
      if (d.error) setError(d.error);
      if (!label) setLabel(f.name.replace(/\.[^.]+$/, "").slice(0, 80));
    } catch (e: unknown) {
      setAnalysis(null);
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setBusy(null);
    }
  }

  function choose(f: File | null) {
    if (!f) return;
    setFile(f);
    setOverrides({});
    setAnalysis(null);
    void preview(f);
  }

  // Re-previewing on every change keeps the tier, the capability list and the
  // totals honest: change the spend column and the numbers below must follow.
  function remap(field: Field, column: number) {
    const next = { ...overrides, [field]: column };
    setOverrides(next);
    if (file) void preview(file, { ...(analysis?.mapping ?? {}), ...next });
  }

  async function commit() {
    if (!file || !analysis) return;
    setBusy("commit");
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("mapping", JSON.stringify(effectiveMapping));
      body.append("label", label);
      body.append("timezone", timezone);
      const res = await fetch("/api/upload?mode=commit", { method: "POST", body });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error ?? "Could not save that upload.");
      setCommitted(d.batch);
      refreshBatches();
      const acct = await fetch(`/api/db/accounts?account=${encodeURIComponent(d.batch.id)}&t=${Date.now()}`, { cache: "no-store" })
        .then((r) => r.json()).catch(() => null);
      setCampaigns((acct?.campaigns ?? []).slice(0, 8));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save that upload.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? Its campaigns and every metric read from that file are removed.`)) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/upload?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Delete failed");
      refreshBatches();
      if (committed?.id === id) { setCommitted(null); setCampaigns([]); }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not delete that upload.");
    } finally {
      setDeleting(null);
    }
  }

  function reset() {
    setFile(null); setAnalysis(null); setOverrides({}); setCommitted(null);
    setCampaigns([]); setError(null); setLabel("");
    if (inputRef.current) inputRef.current.value = "";
  }

  const blocked = (analysis?.errors.length ?? 0) > 0;

  return (
    <div className="max-w-4xl mx-auto px-8 py-7">
      <PageHeader kicker="Uploads" title="Upload a report"
        sub="No account access needed. Upload an Ads Manager export and AdLens analyses it exactly as it would live data." />

      {/* ── step 1: the file ─────────────────────────────────────── */}
      {!committed && (
        <>
          <div className="card p-4 mb-4" style={{ background: "var(--hero-grad-soft)" }}>
            <div className="flex items-start gap-2.5">
              <Info size={15} className="text-accent mt-0.5 shrink-0" />
              <div className="text-[12.5px] text-mut font-medium leading-relaxed">
                <strong className="text-ink">For the deepest analysis</strong>, export from Ads Manager with a
                breakdown <strong className="text-ink">by Day</strong> at the <strong className="text-ink">Ad</strong> level,
                including Amount spent, Impressions, Link clicks, Frequency, Results and Conversion value.
                Anything less still works — the preview below tells you exactly what you lose.
                <div className="mt-1.5">.csv, .tsv and .xlsx are supported. Hosted deployments cap uploads at about 4.5MB;
                  split a larger export by date range.</div>
              </div>
            </div>
          </div>

          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0] ?? null); }}
            onClick={() => inputRef.current?.click()}
            className={clsx(
              "card p-8 mb-5 text-center cursor-pointer border-2 border-dashed transition-colors",
              dragging ? "border-accent" : "border-line2 hover:border-accent/50")}
            style={dragging ? { background: "var(--accent-soft)" } : undefined}>
            <input ref={inputRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm" className="hidden"
              onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            <Upload size={26} className="mx-auto mb-2.5 text-accent" />
            <div className="text-[14px] font-bold">{file ? file.name : "Drop your export here, or click to choose"}</div>
            <div className="text-[12px] text-mut font-medium mt-1">
              {file ? `${(file.size / 1024).toFixed(0)} KB${busy === "preview" ? " · reading…" : ""}` : "Ads Manager export · .csv, .tsv or .xlsx"}
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="card p-4 mb-5 border-bad/40">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="text-bad mt-0.5 shrink-0" />
            <div className="text-[13px] font-semibold text-bad">{error}</div>
          </div>
        </div>
      )}

      {/* ── step 3: committed ────────────────────────────────────── */}
      <AnimatePresence>
        {committed && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="card p-5 mb-5 border-good/40">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-6 h-6 rounded-lg bg-good/15 text-good grid place-items-center"><Check size={14} /></span>
              <div className="text-[15px] font-bold">{committed.label} is ready</div>
            </div>
            <div className="text-[12.5px] text-mut font-medium mb-3.5">
              {committed.campaigns} campaigns · {committed.adsets} ad sets{committed.ads ? ` · ${committed.ads} ads` : ""} ·{" "}
              {committed.distinctDays} days ({committed.dateStart} to {committed.dateEnd}) · {committed.currency}
            </div>
            {campaigns.length > 0 && (
              <>
                <div className="section-label mb-2">Analyse a campaign</div>
                <div className="card overflow-hidden divide-y divide-line mb-3.5">
                  {campaigns.map((c) => (
                    <Link key={c.id} href={`/analysis/${c.id}`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-raised transition-colors">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-bold truncate">{c.name}</div>
                        <div className="text-[11px] text-mut font-medium num">
                          {money(c.spend, committed.currency)}
                          {c.roas > 0 ? ` · ROAS ${c.roas}x` : " · revenue not reported"}
                        </div>
                      </div>
                      <ArrowRight size={14} className="text-mut shrink-0" />
                    </Link>
                  ))}
                </div>
              </>
            )}
            <div className="flex gap-2.5">
              <Link href="/check" className="btn-primary">Open the account check</Link>
              <button onClick={reset} className="btn-ghost">Upload another</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── step 2: the preview ──────────────────────────────────── */}
      {analysis && !committed && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          {/* tier */}
          <div className={clsx("card p-5 mb-4 border", TIER_TONE[analysis.tier])}>
            <div className="flex items-baseline gap-2.5 flex-wrap mb-1">
              <span className="section-label">This file gives you</span>
              <span className="text-[17px] font-bold">{TIER_LABEL[analysis.tier]}</span>
            </div>
            <div className="text-[12.5px] text-mut font-medium leading-relaxed">{TIER_BLURB[analysis.tier]}</div>
          </div>

          {/* what's in the file */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[
              ["Rows", analysis.counts.rows.toLocaleString()],
              ["Campaigns", analysis.counts.campaigns.toLocaleString()],
              ["Ad sets", analysis.counts.adsets.toLocaleString()],
              ["Ads", analysis.counts.ads.toLocaleString()],
              ["Days", String(analysis.distinctDays)],
              ["Date range", analysis.dateStart ? `${analysis.dateStart} → ${analysis.dateEnd}` : "none"],
              ["Spend", money(analysis.totals.spend, analysis.currency)],
              ["Conv. value", analysis.totals.convValue === null ? "not reported" : money(analysis.totals.convValue, analysis.currency)],
            ].map(([k, v]) => (
              <div key={k} className="card p-3">
                <div className="section-label mb-1">{k}</div>
                <div className="text-[13.5px] font-bold num truncate" title={v}>{v}</div>
              </div>
            ))}
          </div>

          {/* capabilities */}
          <div className="section-label mb-2">What will work on this data</div>
          <div className="card overflow-hidden divide-y divide-line mb-4">
            {analysis.capabilities.map((c) => (
              <div key={c.key} className="flex items-start gap-3 px-4 py-2.5">
                <span className={clsx("w-[18px] h-[18px] rounded-md grid place-items-center shrink-0 mt-0.5",
                  c.available ? "bg-good/15 text-good" : "bg-mut/10 text-mut")}>
                  {c.available ? <Check size={12} /> : <X size={12} />}
                </span>
                <div className="min-w-0">
                  <div className={clsx("text-[13px] font-bold", !c.available && "text-mut")}>{c.label}</div>
                  <div className="text-[11.5px] text-mut font-medium leading-snug">{c.reason}</div>
                </div>
              </div>
            ))}
          </div>

          {/* warnings */}
          {analysis.warnings.length > 0 && (
            <>
              <div className="section-label mb-2">Read this before committing</div>
              <div className="card p-4 mb-4 border-warn/30">
                <ul className="space-y-2">
                  {analysis.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-[12.5px] text-mut font-medium leading-relaxed">
                      <AlertTriangle size={13} className="text-warn mt-0.5 shrink-0" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          {/* mapping */}
          <div className="section-label mb-2">Column mapping — correct anything that looks wrong</div>
          <div className="card overflow-hidden mb-4">
            <div className="max-h-[420px] overflow-y-auto divide-y divide-line">
              {FIELD_SPECS.map((spec) => {
                const current = effectiveMapping[spec.key];
                const missingRequired = spec.required && current === undefined;
                return (
                  <div key={spec.key} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="w-[150px] shrink-0">
                      <div className={clsx("text-[12.5px] font-bold", missingRequired && "text-bad")}>
                        {spec.label}{spec.required && <span className="text-bad"> *</span>}
                      </div>
                      <div className="text-[10.5px] text-mut font-medium leading-snug">{spec.help}</div>
                    </div>
                    <select
                      value={current === undefined ? -1 : current}
                      onChange={(e) => remap(spec.key, Number(e.target.value))}
                      className={clsx(
                        "flex-1 min-w-0 text-[12.5px] font-semibold px-2.5 py-1.5 rounded-lg border bg-surface outline-none focus:border-accent focus:ring-2 focus:ring-accent/20",
                        missingRequired ? "border-bad/50" : current === undefined ? "border-line2 text-mut" : "border-line2")}>
                      <option value={-1}>— not in this file —</option>
                      {analysis.headers.map((h, i) => (
                        <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>

          {analysis.unmapped.length > 0 && (
            <div className="card p-3.5 mb-4">
              <div className="section-label mb-1.5">Columns being ignored</div>
              <div className="text-[12px] text-mut font-medium">{analysis.unmapped.join(" · ")}</div>
            </div>
          )}

          {/* commit */}
          <div className="card p-4 mb-4">
            <div className="section-label mb-2">Name this report</div>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80}
              placeholder="e.g. Urban Air — August pacing"
              className="w-full text-[13px] font-semibold px-3 py-2.5 rounded-xl border border-line2 bg-surface outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" />
            <div className="text-[11.5px] text-mut font-medium mt-1.5">
              It appears in the account picker alongside any connected ad accounts. Dates are read in {timezone}.
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 mb-8">
            <button onClick={reset} className="btn-ghost">Cancel</button>
            <button onClick={commit} disabled={blocked || busy !== null} className="btn-primary">
              {busy === "commit" ? "Saving…" : blocked ? "Fix the errors above" : `Commit ${analysis.counts.campaigns} campaigns`}
            </button>
          </div>
        </motion.div>
      )}

      {/* ── existing uploads ─────────────────────────────────────── */}
      {batches.length > 0 && (
        <>
          <div className="section-label mb-2">Uploaded reports</div>
          <div className="card overflow-hidden divide-y divide-line mb-8">
            {batches.map((b) => (
              <div key={b.id} className="flex items-center gap-3 px-4 py-3.5">
                <FileSpreadsheet size={16} className="text-accent shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-bold truncate flex items-center gap-2">
                    {b.label}
                    <span className={clsx("pill", b.tier === "full" ? "pill-good" : b.tier === "trends" ? "pill-accent" : "pill-warn")}>
                      {TIER_LABEL[b.tier]}
                    </span>
                  </div>
                  <div className="text-[11px] text-mut font-medium truncate">
                    {b.filename} · {b.campaigns} campaigns · {b.distinctDays}d
                    {b.dateStart ? ` (${b.dateStart} → ${b.dateEnd})` : ""} · {b.currency} ·
                    {" "}uploaded {new Date(b.uploadedAt).toLocaleString()}
                  </div>
                </div>
                <Link href="/check" className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-line2 hover:bg-raised shrink-0">
                  Analyse
                </Link>
                <button onClick={() => remove(b.id, b.label)} disabled={deleting === b.id}
                  title="Delete this report and every metric read from it"
                  className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-line2 hover:border-bad hover:text-bad disabled:opacity-40 transition-colors shrink-0">
                  {deleting === b.id ? "Deleting…" : <Trash2 size={13} />}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
