"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { Search, FileText, Upload } from "lucide-react";
import { campaigns } from "@/lib/data";
import { PlatBadge, StatusBadge } from "@/components/Badge";
import PageHeader from "@/components/PageHeader";
import clsx from "clsx";

// "Acme Corp" rows are the SEEDED demo accounts that ship with the prototype.
// The connected live account is fetched at runtime and listed first.
const ACCOUNTS = [
  { id: "meta", name: "Acme Corp — Main (demo)", sub: "act_12345678 · Meta · 3 campaigns", plat: "meta" as const, spend: "$4,200/mo", camps: 3 },
  { id: "li", name: "Acme Corp LinkedIn", sub: "id_509876543 · LinkedIn · 2 campaigns", plat: "li" as const, spend: "$2,800/mo", camps: 2 },
];

export default function Reporting() {
  const router = useRouter();
  const [acct, setAcct] = useState("meta");
  const [q, setQ] = useState("");
  const [camp, setCamp] = useState("summer-sale");
  const [compare, setCompare] = useState(false);
  const [preset, setPreset] = useState("Last month");

  type Accessible = { id: string; name: string; currency: string; kind?: "graph" | "upload"; upload?: { filename: string; campaigns: number; days: number; dateStart: string | null; dateEnd: string | null } };
  const [live, setLive] = useState<{ configured: boolean; account?: { id: string; name: string; currency: string }; accessibleAccounts?: Accessible[]; campaigns: typeof campaigns } | null>(null);

  // Re-fetched per selected account: an uploaded report only returns its own
  // campaigns when it is the account being asked about.
  useEffect(() => {
    const qs = new URLSearchParams({ t: String(Date.now()) });
    if (acct.startsWith("live:")) qs.set("account", acct.slice(5));
    fetch(`/api/db/accounts?${qs}`, { cache: "no-store" })
      .then((r) => r.json()).then(setLive)
      .catch(() => setLive({ configured: false, campaigns: [] as typeof campaigns }));
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
    ? { id: "live", name: live.account.name, sub: `act_${live.account.id} · Meta · ${live.campaigns.length} live campaigns`, plat: "meta" as const, spend: `${live.account.currency}`, camps: live.campaigns.length }
    : null;
  const allAccounts = [...uploadRows, ...(liveRow ? [liveRow] : []), ...ACCOUNTS];
  const account = allAccounts.find((a) => a.id === acct) ?? allAccounts[0];
  const usingLive = acct === "live" || acct.startsWith("live:");
  const list = useMemo(() =>
    (usingLive ? (live?.campaigns ?? []) : campaigns.filter((c) => c.platform === acct && c.status === "Active")).filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6),
    [acct, q, live, usingLive]);  // eslint-disable-line react-hooks/exhaustive-deps

  const Step = ({ n, label }: { n: number; label: string }) => (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="w-7 h-7 rounded-xl text-white text-[12px] font-bold grid place-items-center shadow-hero" style={{ background: "var(--hero-grad)" }}>{n}</span>
      <span className="section-label">{label}</span>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto px-8 py-7">
      <PageHeader kicker="Reports" title="Build a report"
        sub="Reports cover one campaign at a time. Pick the account, then the campaign, then generate." />

      <Step n={1} label="Select ad account" />
      <div className="card overflow-hidden divide-y divide-line mb-2">
        {allAccounts.map((a) => (
          <button key={a.id} onClick={() => {
            setAcct(a.id);
            const first = a.id === "live" || a.id.startsWith("live:")
              ? live?.campaigns?.[0]
              : campaigns.find((c) => c.platform === a.id && c.status === "Active");
            if (first) setCamp(first.id);
          }}
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
        {[["Account", account.name], ["Platform", account.plat === "meta" ? "Meta" : "LinkedIn"], ["Monthly spend", account.spend], ["Active campaigns", String(account.camps)]].map(([l, v]) => (
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
            <span className="ml-auto text-[11px] text-mut font-medium num">${c.spend.toLocaleString()} · {c.roas}x · {c.ctr}%</span>
          </button>
        ))}
      </div>

      <Step n={3} label="Report period" />
      <div className="flex items-center gap-2.5 mb-4 flex-wrap">
        <div className="flex rounded-xl border border-line2 bg-surface p-1">
          {["Last week", "Last month", "Overall", "Custom"].map((p) => (
            <button key={p} onClick={() => setPreset(p)} className={clsx("relative text-[12px] font-bold px-3.5 py-1.5 rounded-lg", preset === p ? "text-white" : "text-mut hover:text-ink")}>
              {preset === p && <motion.span layoutId="rep-pill" className="absolute inset-0 rounded-lg" style={{ background: "var(--hero-grad)" }} transition={{ type: "spring", stiffness: 400, damping: 34 }} />}
              <span className="relative z-10">{p}</span>
            </button>
          ))}
        </div>
        {preset === "Custom" ? <CustomDates /> : <span className="text-[12px] text-mut font-medium">{preset === "Last week" ? "Jul 3 – Jul 9" : preset === "Last month" ? "Jun 1 – Jun 30, 2025" : "Mar 1 – Jul 9 (all time)"}</span>}
      </div>

      <div className="card p-4 mb-5 flex items-center gap-3 flex-wrap">
        <button onClick={() => setCompare(!compare)} className={clsx("w-10 h-[22px] rounded-full transition-colors relative", compare ? "bg-accent" : "bg-line2")}>
          <motion.span layout className="absolute top-[3px] w-4 h-4 bg-white rounded-full shadow" animate={{ left: compare ? 21 : 3 }} />
        </button>
        <span className="text-[13px] font-semibold">Compare against a previous period</span>
        {compare && (
          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pill-good ml-1">
            vs May 1 – May 31, 2025
          </motion.span>
        )}
      </div>

      <div className="flex justify-end">
        <button onClick={() => router.push(`/report?c=${camp}&cmp=${compare ? 1 : 0}`)} className="btn-primary">
          <FileText size={15} /> Generate report →
        </button>
      </div>
    </div>
  );
}

function CustomDates() {
  const [from, setFrom] = useState("2025-06-01");
  const [to, setTo] = useState("2025-06-30");
  return (
    <div className="flex items-center gap-1.5 text-[12px]">
      <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} className="border border-line2 rounded-xl px-2.5 py-1.5 bg-surface" />
      <span className="text-mut">to</span>
      <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value < from ? from : e.target.value)} className="border border-line2 rounded-xl px-2.5 py-1.5 bg-surface" />
    </div>
  );
}
