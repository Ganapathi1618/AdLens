"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { Search, FileText, Upload } from "lucide-react";
import type { Campaign } from "@/lib/types";
import { PlatBadge, StatusBadge } from "@/components/Badge";
import PageHeader from "@/components/PageHeader";
import clsx from "clsx";
import { money } from "@/lib/currency";

export default function Reporting() {
  const router = useRouter();
  const [acct, setAcct] = useState("");
  const [q, setQ] = useState("");
  const [camp, setCamp] = useState("");
  const [compare, setCompare] = useState(false);

  type Accessible = { id: string; name: string; currency: string; kind?: "graph" | "upload"; upload?: { filename: string; campaigns: number; days: number; dateStart: string | null; dateEnd: string | null } };
  const [live, setLive] = useState<{ configured: boolean; account?: { id: string; name: string; currency: string }; accessibleAccounts?: Accessible[]; campaigns: Campaign[] } | null>(null);

  // Re-fetched per selected account: an uploaded report only returns its own
  // campaigns when it is the account being asked about.
  useEffect(() => {
    const qs = new URLSearchParams({ t: String(Date.now()) });
    if (acct.startsWith("live:")) qs.set("account", acct.slice(5));
    fetch(`/api/db/accounts?${qs}`, { cache: "no-store" })
      .then((r) => r.json()).then(setLive)
      .catch(() => setLive({ configured: false, campaigns: [] }));
  }, [acct]);

  // Uploaded reports are selectable here exactly like connected accounts.
  const uploadRows = (live?.accessibleAccounts ?? [])
    .filter((a) => a.kind === "upload")
    .map((a) => ({
      id: `live:${a.id}`,
      name: a.name,
      sub: `Uploaded · ${a.upload?.filename ?? "report"} · ${a.upload?.campaigns ?? 0} campaigns${a.upload?.dateStart ? ` · ${a.upload.dateStart} → ${a.upload.dateEnd}` : ""}`,
      plat: "meta" as const,
      spend: a.currency,
      camps: a.upload?.campaigns ?? 0,
    }));
  const liveRow = live?.configured && live.account && !acct.startsWith("live:")
    ? { id: "live", name: live.account.name, sub: `act_${live.account.id} · Meta · ${live.campaigns.length} campaigns`, plat: "meta" as const, spend: `${live.account.currency}`, camps: live.campaigns.length }
    : null;
  const allAccounts = [...uploadRows, ...(liveRow ? [liveRow] : [])];
  const account = allAccounts.find((a) => a.id === acct) ?? allAccounts[0] ?? null;
  const list = useMemo(() =>
    (live?.campaigns ?? []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6),
    [q, live]);

  // Select the first account and campaign as soon as they are known, so the
  // wizard never sits on a selection that no longer exists.
  useEffect(() => {
    if (!acct && allAccounts.length) setAcct(allAccounts[0].id);
  }, [acct, allAccounts]);
  useEffect(() => {
    if (live?.campaigns?.length && !live.campaigns.some((c) => c.id === camp)) setCamp(live.campaigns[0].id);
  }, [live, camp]);

  const Step = ({ n, label }: { n: number; label: string }) => (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="w-7 h-7 rounded-xl text-white text-[12px] font-bold grid place-items-center shadow-hero" style={{ background: "var(--hero-grad)" }}>{n}</span>
      <span className="section-label">{label}</span>
    </div>
  );

  // Nothing to report on until an account is connected or a report uploaded.
  // Rendering the wizard against no account would read as a broken page.
  if (!account) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-7">
        <PageHeader kicker="Reports" title="Build a report" sub="No account available yet" />
        <div className="card p-8 text-center">
          <FileText size={28} className="mx-auto text-mut mb-3" />
          <div className="font-bold text-[15px] mb-1">Nothing to report on yet</div>
          <p className="text-[13px] text-mut max-w-md mx-auto mb-4">
            Reports are generated from a campaign’s own data. Connect an ad account
            or upload an Ads Manager export, then come back here.
          </p>
          <div className="flex gap-2 justify-center">
            <button onClick={() => router.push("/check")} className="btn-primary">Connect an account</button>
            <Link href="/upload" className="btn-ghost"><Upload size={13} /> Upload a report</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-8 py-7">
      <PageHeader kicker="Reports" title="Build a report"
        sub="Reports cover one campaign at a time. Pick the account, then the campaign, then generate." />

      <Step n={1} label="Select ad account" />
      <div className="card overflow-hidden divide-y divide-line mb-2">
        {allAccounts.map((a) => (
          <button key={a.id} onClick={() => setAcct(a.id)}
            className={clsx("w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors", acct === a.id ? "" : "hover:bg-raised")}
            style={acct === a.id ? { background: "var(--accent-soft)" } : undefined}>
            <span className={clsx("w-[18px] h-[18px] rounded-full border-2 grid place-items-center shrink-0", acct === a.id ? "border-accent bg-accent" : "border-line2 bg-surface")}>
              {acct === a.id && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
            </span>
            <div><div className="text-[13.5px] font-bold">{a.name}</div><div className="text-[11px] text-mut font-medium">{a.sub}</div></div>
            <span className="ml-auto"><PlatBadge p={a.plat} /></span>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3 px-1">
        <span className="text-[11.5px] text-mut font-medium">
          {uploadRows.length === 0
            ? "No account access, or reporting on an export? Upload one and it appears here as an account."
            : `${uploadRows.length} uploaded report${uploadRows.length === 1 ? "" : "s"} listed above.`}
        </span>
        <Link href="/upload" className="text-[11.5px] font-bold text-accent hover:underline inline-flex items-center gap-1.5 shrink-0">
          <Upload size={13} /> Upload a report
        </Link>
      </div>

      <motion.div key={acct} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
        className="card p-4 mb-5 flex gap-7 flex-wrap text-[13px]">
        {[["Account", account.name], ["Platform", account.plat === "meta" ? "Meta" : "LinkedIn"], ["Currency", account.spend], ["Campaigns", String(account.camps)]].map(([l, v]) => (
          <div key={l}><div className="text-[10px] font-bold uppercase tracking-wide text-mut mb-0.5">{l}</div><div className="font-bold">{v}</div></div>
        ))}
        <div><div className="text-[10px] font-bold uppercase tracking-wide text-mut mb-0.5">Status</div><StatusBadge s="Active" /></div>
      </motion.div>

      <div className="flex items-center justify-between mb-2">
        <Step n={2} label="Select one campaign" />
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-mut" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="text-[12px] font-medium pl-8 pr-3 py-2 rounded-xl border border-line2 bg-surface outline-none focus:border-accent w-48" />
        </div>
      </div>
      <div className="card overflow-hidden divide-y divide-line mb-5">
        {list.map((c) => (
          <button key={c.id} onClick={() => setCamp(c.id)}
            className={clsx("w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors", camp === c.id ? "" : "hover:bg-raised")}
            style={camp === c.id ? { background: "var(--accent-soft)" } : undefined}>
            <span className={clsx("w-[18px] h-[18px] rounded-full border-2 grid place-items-center shrink-0", camp === c.id ? "border-accent bg-accent" : "border-line2 bg-surface")}>
              {camp === c.id && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
            </span>
            <div className="text-[13.5px] font-bold">{c.name}</div>
            <span className="ml-auto text-[11px] text-mut font-medium num">{money(c.spend, c.currency)} · {c.roas > 0 ? `${c.roas}x` : "no revenue"} · {c.ctr}%</span>
          </button>
        ))}
      </div>

      <Step n={3} label="Report period" />
      <div className="card p-4 mb-5 flex items-center gap-3 flex-wrap">
        <button onClick={() => setCompare(!compare)} className={clsx("w-10 h-[22px] rounded-full transition-colors relative", compare ? "bg-accent" : "bg-line2")}>
          <motion.span layout className="absolute top-[3px] w-4 h-4 bg-white rounded-full shadow" animate={{ left: compare ? 21 : 3 }} />
        </button>
        <div>
          <div className="text-[13px] font-semibold">Compare against the preceding period</div>
          <div className="text-[11.5px] text-mut font-medium mt-0.5">
            The report covers everything stored for this campaign, split in half against itself when comparison is on.
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={() => router.push(`/report?c=${camp}&cmp=${compare ? 1 : 0}`)} className="btn-primary">
          <FileText size={15} /> Generate report →
        </button>
      </div>
    </div>
  );
}
