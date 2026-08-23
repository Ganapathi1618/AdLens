"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Check as CheckIcon, Search } from "lucide-react";
import type { Campaign } from "@/lib/types";
import { useApp } from "@/lib/store";
import { PlatBadge, StatusBadge, NoActiveCampaigns } from "@/components/Badge";
import PageHeader from "@/components/PageHeader";
import clsx from "clsx";
import { sym } from "@/lib/currency";

const PLATFORMS = [
  { id: "meta", name: "Meta", color: "#1877F2", enabled: true },
  { id: "li", name: "LinkedIn", color: "#0A66C2", enabled: false },
  { id: "google", name: "Google Ads", color: "#EA4335", enabled: false },
  { id: "tiktok", name: "TikTok", color: "#8b93a8", enabled: false },
];
export default function Check() {
  const router = useRouter();
  const setCampaign = useApp((s) => s.setCampaign);
  const [step, setStep] = useState(0);
  const [plats, setPlats] = useState<string[]>(["meta"]);
  const [acctByPlat, setAcctByPlat] = useState<Record<string, string>>({});
  const [camp, setCamp] = useState("");
  const [search, setSearch] = useState("");

  // ── Live connected account (real Meta data) ──────────────────────
  type LiveCamp = Campaign;
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [live, setLive] = useState<{ configured: boolean; account?: { id: string; name: string; currency: string }; campaigns: LiveCamp[]; liveError?: string | null; lastSynced?: string | null; accessibleAccounts?: { id: string; name: string; currency: string; timezone: string; status: number; business: string | null; connectionId?: string | null; kind?: "graph" | "upload"; upload?: { filename: string; tier: string; level: string; granularity: string; dateStart: string | null; dateEnd: string | null; days: number; campaigns: number; uploadedAt: string } }[]; discoveryError?: string | null; uploadsOnly?: boolean } | null>(null);
  const chosenAccount = String(acctByPlat["meta"] ?? "");
  // Discovering live accounts calls the Meta Graph API, which is routinely a
  // few seconds — the picker must say so rather than looking like the demo
  // accounts are all there is.
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  useEffect(() => {
    const acct = chosenAccount.startsWith("live:") ? chosenAccount.slice(5) : "";
    const qs = new URLSearchParams({ t: String(Date.now()) });
    if (acct) qs.set("account", acct);
    setLoadingAccounts(true);
    fetch(`/api/db/accounts?${qs}`, { cache: "no-store" })
      .then((r) => r.json()).then(setLive)
      .catch(() => setLive({ configured: false, campaigns: [] }))
      .finally(() => setLoadingAccounts(false));
  }, [chosenAccount]);

  // An uploaded report and a connected ad account are both selectable here, but
  // they must never look alike: one is a frozen file, the other a live sync.
  const liveAccts = (live?.accessibleAccounts ?? []).map((a) => ({
    id: `live:${a.id}`,
    name: a.name,
    kind: (a.kind ?? "graph") as "graph" | "upload",
    sub: a.kind === "upload" && a.upload
      ? `${a.upload.filename} · ${a.upload.campaigns} campaigns · ${a.upload.days}d${a.upload.dateStart ? ` (${a.upload.dateStart} → ${a.upload.dateEnd})` : ""} · ${a.currency}`
      : `act_${a.id} · ${a.currency} · ${a.timezone}${a.business ? ` · ${a.business}` : ""}${a.status !== 1 ? " · inactive" : ""}`,
    connectionId: a.connectionId ?? null,
    uploadedAt: a.kind === "upload" ? a.upload?.uploadedAt ?? null : null,
  }));
  async function syncNow(accountId: string) {
    setSyncing(true);
    setSyncMsg("Syncing campaigns → ad sets → ads from Meta… please wait, this can take up to a minute for large accounts.");
    try {
      const qs = new URLSearchParams({ preset: "last_30", t: String(Date.now()) });
      if (accountId) qs.set("account", accountId);
      const r = await fetch(`/api/sync/meta?${qs}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.synced) {
        setSyncMsg(`Sync failed: ${d.error ?? d.reason ?? "unknown"}${d.hint ? ` — ${d.hint}` : ""}`);
        return;
      }
      setSyncMsg(
        `Synced ${d.campaigns ?? 0} campaigns · ${d.adsets ?? 0} ad sets · ${d.ads ?? 0} ads` +
        `${d.dayRows === 0 ? " — no new delivery in this window (campaigns may be paused)" : ` · ${d.dayRows} day-rows`}`
      );
      const q2 = new URLSearchParams({ t: String(Date.now()) });
      if (accountId) q2.set("account", accountId);
      const fresh = await fetch(`/api/db/accounts?${q2}`, { cache: "no-store" }).then((x) => x.json());
      setLive(fresh);
    } catch (e: any) {
      setSyncMsg(`Sync failed: ${e?.message ?? "network error"}`);
    } finally {
      setSyncing(false);
    }
  }

  // Status of the selected account comes from the campaigns Meta last reported.
  const activeCampaignCount = (live?.campaigns ?? []).filter((c) => c.status === "Active").length;

  const syncAgeHours = live?.lastSynced
    ? (Date.now() - new Date(live.lastSynced).getTime()) / 3_600_000
    : null;
  const stale = syncAgeHours != null && syncAgeHours > 36;

  // ── Connect with Facebook ────────────────────────────────────────
  // The user grants access on Meta's own consent screen; we never ask them to
  // create an app or paste a token.
  const [conn, setConn] = useState<{ oauthConfigured: boolean; connections: { id: string; fbUserName: string }[] } | null>(null);
  const [connectMsg, setConnectMsg] = useState<{ kind: "success" | "error" | "cancelled" | "empty"; text: string } | null>(null);

  const refreshConnections = () =>
    fetch("/api/connections", { cache: "no-store" }).then((r) => r.json()).then(setConn).catch(() => setConn(null));

  useEffect(() => { refreshConnections(); }, []);

  // Read the outcome the OAuth callback redirected back with, then clean the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const status = p.get("connect");
    if (!status) return;
    const reason = p.get("reason") ?? "";
    if (status === "success") {
      setConnectMsg({ kind: "success", text: `Connected ${p.get("who") ?? "your Meta account"} — ${p.get("accounts")} ad account(s) available below.` });
      refreshConnections();
      fetch(`/api/db/accounts?t=${Date.now()}`, { cache: "no-store" }).then((r) => r.json()).then(setLive).catch(() => {});
    } else if (status === "cancelled") {
      setConnectMsg({ kind: "cancelled", text: "Connection cancelled — no access was granted." });
    } else if (status === "empty") {
      setConnectMsg({ kind: "empty", text: reason || "No ad accounts were shared." });
    } else {
      setConnectMsg({ kind: "error", text: reason || "Could not connect." });
    }
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  /** Disconnect one connected Meta account. The stored token is deleted server
   *  side; the picker refreshes immediately so the account disappears. */
  async function disconnect(connectionId: string, label: string) {
    if (!connectionId || disconnecting) return;
    if (!window.confirm(`Disconnect ${label}? AdLens will lose access to its data until it is reconnected.`)) return;
    setDisconnecting(connectionId);
    setConnectMsg(null);
    try {
      const res = await fetch(`/api/connections?id=${encodeURIComponent(connectionId)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Disconnect failed (${res.status})`);
      }
      // Drop the selection if the account that was selected is now gone.
      setAcctByPlat((prev) => (String(prev.meta ?? "").startsWith("live:") ? { ...prev, meta: "" } : prev));
      await refreshConnections();
      const fresh = await fetch(`/api/db/accounts?t=${Date.now()}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
      if (fresh) setLive(fresh);
      setConnectMsg({ kind: "success", text: `${label} disconnected. Its stored access token has been removed.` });
    } catch (e: unknown) {
      setConnectMsg({ kind: "error", text: e instanceof Error ? e.message : "Could not disconnect that account." });
    } finally {
      setDisconnecting(null);
    }
  }

  // One shape for every row in the picker. connectionId is what decides
  // whether Disconnect is offered — an env-credential account carries none.
  type PickerAccount = { id: string; name: string; sub: string; connectionId?: string | null; kind?: "graph" | "upload"; uploadedAt?: string | null };
  const liveAcct: PickerAccount[] = liveAccts.length === 0 && live?.configured && live.account
    ? [{ id: "live", name: live.account.name, sub: `act_${live.account.id} · ${live.account.currency}`, connectionId: null, kind: "graph" }]
    : liveAccts;
  const accountsFor = (pid: string): PickerAccount[] => (pid === "meta" ? liveAcct : []);
  const usingUpload = liveAcct.some((a) => a.id === acctByPlat["meta"] && a.kind === "upload");
  const pool = live?.campaigns ?? [];
  const curSym = sym(live?.account?.currency);
  useEffect(() => {
    setCamp(live?.campaigns?.length ? live.campaigns[0].id : "");
  }, [live]);

  const singleList = pool.filter((c) => plats.includes(c.platform) && c.name.toLowerCase().includes(search.toLowerCase())).slice(0, 8);
  const accountsChosen = plats.every((p) => acctByPlat[p]);

  const go = () => {
    const c = pool.find((x) => x.id === camp);
    if (!c) return;
    setCampaign(c.id, c.name);
    router.push(`/analysis/${c.id}`);
  };

  const steps = ["Platform", "Account", "Campaign"];
  return (
    <div className="max-w-3xl mx-auto px-8 py-7">
      <PageHeader kicker="Wizard" title="Account check"
        sub="Pick a platform, an account and a campaign — get the full AI analysis." />

      {/* Step rail */}
      <div className="flex items-center gap-0 mb-7">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center flex-1 last:flex-none">
            <div className={clsx("flex items-center gap-2 text-[13px] font-bold", i < step ? "text-good" : i === step ? "text-ink" : "text-mut")}>
              <span className={clsx("w-8 h-8 rounded-xl grid place-items-center text-[12px] font-bold border-2 transition-all",
                i < step ? "bg-good/15 border-good/40 text-good" : i === step ? "border-transparent text-white shadow-hero" : "border-line2")}
                style={i === step ? { background: "var(--hero-grad)" } : undefined}>
                {i < step ? <CheckIcon size={14} /> : i + 1}
              </span>{s}
            </div>
            {i < steps.length - 1 && <div className={clsx("flex-1 h-0.5 mx-3 rounded", i < step ? "bg-good/50" : "bg-line2")} />}
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {step === 0 && (
          <motion.div key="p" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
            <div className="section-label mb-2">Select one or more platforms</div>
            <div className="text-[13px] text-mut rounded-xl px-4 py-3 mb-4 border border-accent/25" style={{ background: "var(--accent-soft)" }}>
              💡 Pick the platform your ad account lives on, then the account and the campaign to analyse.
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              {PLATFORMS.map((p) => {
                const on = plats.includes(p.id);
                return (
                  <button key={p.id} disabled={!p.enabled}
                    onClick={() => setPlats(on ? plats.filter((x) => x !== p.id) : [...plats, p.id])}
                    className={clsx("card p-4 flex items-center gap-3 text-[14px] font-bold transition-all",
                      !p.enabled && "opacity-40 cursor-not-allowed",
                      on && "border-accent/50 ring-1 ring-accent/30")}
                    style={on ? { background: "var(--accent-soft)" } : undefined}>
                    <span className="w-9 h-9 rounded-xl grid place-items-center text-white text-[12px] font-bold" style={{ background: p.color }}>
                      {p.name[0]}
                    </span>
                    {p.name}
                    {p.enabled ? (
                      <span className={clsx("ml-auto w-[22px] h-[22px] rounded-lg border-2 grid place-items-center text-white transition-colors", on ? "bg-accent border-accent" : "border-line2 bg-surface")}>
                        {on && <CheckIcon size={13} />}
                      </span>
                    ) : <span className="ml-auto pill-mut">soon</span>}
                  </button>
                );
              })}
            </div>
            <motion.p key={plats.length} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className={clsx("text-[12.5px] font-bold mb-5", plats.length === 0 ? "text-bad" : "text-accent")}>
              {plats.length === 0 ? "⚠ Select a platform" : "✓ Single campaign analysis"}
            </motion.p>
            <div className="flex justify-end">
              <button disabled={plats.length === 0} onClick={() => setStep(1)} className="btn-primary">Next: Select account →</button>
            </div>
          </motion.div>
        )}

        {step === 1 && (
          <motion.div key="a" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
            {plats.map((pid) => (
              <div key={pid} className="mb-5">
                <div className="section-label mb-2 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: PLATFORMS.find((p) => p.id === pid)!.color }} />
                  {PLATFORMS.find((p) => p.id === pid)!.name} ad accounts — pick one
                  {acctByPlat[pid] && <span className="ml-1 text-good normal-case tracking-normal">✓ {accountsFor(pid).find(a => a.id === acctByPlat[pid])?.name}</span>}
                </div>

                {/* Live discovery goes to the Meta Graph API — say so while it runs,
                    otherwise the demo rows look like the complete list. */}
                {pid === "meta" && loadingAccounts && (
                  <div className="flex items-center gap-2.5 mb-2 px-3.5 py-2.5 rounded-xl border border-accent/25"
                       style={{ background: "var(--accent-soft)" }}>
                    <span className="flex gap-1 shrink-0">
                      {[0, 1, 2].map((i) => (
                        <motion.span key={i} className="w-1.5 h-1.5 rounded-full bg-accent"
                          animate={{ opacity: [0.3, 1, 0.3] }}
                          transition={{ repeat: Infinity, duration: 1, delay: i * 0.2 }} />
                      ))}
                    </span>
                    <span className="text-[12.5px] font-semibold text-accent">
                      Loading your live ad accounts — please wait, this can take a few seconds.
                    </span>
                  </div>
                )}

                <div className="card overflow-hidden divide-y divide-line">
                  {accountsFor(pid).map((a) => (
                    <button key={a.id} onClick={() => setAcctByPlat({ ...acctByPlat, [pid]: a.id })}
                      className={clsx("w-full flex items-center gap-3 px-4 py-3.5 transition-colors text-left", acctByPlat[pid] === a.id ? "" : "hover:bg-raised")}
                      style={acctByPlat[pid] === a.id ? { background: "var(--accent-soft)" } : undefined}>
                      <span className={clsx("w-[18px] h-[18px] rounded-full border-2 grid place-items-center shrink-0", acctByPlat[pid] === a.id ? "border-accent bg-accent" : "border-line2 bg-surface")}>
                        {acctByPlat[pid] === a.id && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                      </span>
                      <div><div className="text-[13.5px] font-bold flex items-center gap-1.5">{a.name}
                        {a.kind === "upload"
                          ? <span className="pill-accent">Uploaded</span>
                          : String(a.id).startsWith("live") && <span className="pill-good">Live</span>}
                      </div><div className="text-[11px] text-mut font-medium">
                        {a.sub}
                        {a.kind === "upload" && a.uploadedAt && (
                          <span className="text-mut">{" · "}uploaded {new Date(a.uploadedAt).toLocaleString()}</span>
                        )}
                        {a.kind !== "upload" && String(a.id).startsWith("live") && live?.lastSynced && (
                          <span className={stale ? "text-warn font-bold" : "text-mut"}>
                            {" · "}synced {new Date(live.lastSynced).toLocaleString()}
                            {stale && ` (${Math.floor((syncAgeHours ?? 0) / 24)}d ago — nightly sync may not be running)`}
                          </span>
                        )}
                      </div></div>
                      <span className="ml-auto flex items-center gap-2">
                        {a.kind === "upload" ? (
                          <Link href="/upload" onClick={(e) => e.stopPropagation()}
                            className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-line2 hover:bg-raised">
                            Re-upload
                          </Link>
                        ) : String(a.id).startsWith("live") && (
                          <button
                            onClick={(e) => { e.stopPropagation(); syncNow(String(a.id).startsWith("live:") ? String(a.id).slice(5) : ""); }}
                            disabled={syncing}
                            className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-line2 hover:bg-raised disabled:opacity-40">
                            {syncing ? "Syncing…" : "Sync now"}
                          </button>
                        )}
                        {a.connectionId && (
                          <button
                            onClick={(e) => { e.stopPropagation(); disconnect(String(a.connectionId), a.name); }}
                            disabled={disconnecting === a.connectionId}
                            title="Remove this account's stored access token"
                            className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-line2 hover:border-bad hover:text-bad disabled:opacity-40 transition-colors">
                            {disconnecting === a.connectionId ? "Disconnecting…" : "Disconnect"}
                          </button>
                        )}
                        {a.kind === "upload"
                          ? null
                          : String(a.id).startsWith("live")
                            ? (activeCampaignCount > 0
                                ? <StatusBadge s="Active" />
                                : <NoActiveCampaigns total={live?.campaigns?.length ?? 0} />)
                            : <StatusBadge s="Active" />}
                      </span>
                    </button>
                  ))}
                </div>

                {/* Self-service connection — Meta only */}
                {pid === "meta" && (
                  <div className="mt-3 rounded-2xl border border-line px-4 py-3.5" style={{ background: "var(--hero-grad-soft)" }}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div>
                        <div className="text-[13px] font-bold">Don&rsquo;t see your account?</div>
                        <div className="text-[11.5px] text-mut font-medium mt-0.5">
                          Connect with Facebook and pick the ad accounts to share — no app setup, no access token.
                        </div>
                      </div>
                      {conn?.oauthConfigured === false ? (
                        <span className="pill-warn shrink-0">Setup needed</span>
                      ) : (
                        <a href="/api/auth/meta" className="btn-primary shrink-0">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.95h-1.51c-1.49 0-1.96.93-1.96 1.89v2.27h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
                          </svg>
                          Connect with Facebook
                        </a>
                      )}
                    </div>

                    {/* Admin-facing: say exactly what is missing, not just "not configured". */}
                    {conn?.oauthConfigured === false && (
                      <div className="mt-3 pt-3 border-t border-line text-[11.5px] text-mut font-medium leading-relaxed">
                        One-time setup by whoever runs this deployment — your users never do this.
                        Create a Meta app with <strong className="text-ink">Facebook Login</strong> (redirect{" "}
                        <span className="num">{typeof window !== "undefined" ? window.location.origin : ""}/api/auth/meta/callback</span>)
                        and <strong className="text-ink">Marketing API</strong>, then set{" "}
                        <span className="num">META_APP_ID</span>, <span className="num">META_APP_SECRET</span> and{" "}
                        <span className="num">TOKEN_ENCRYPTION_KEY</span>. Full steps in{" "}
                        <strong className="text-ink">CONNECT-META.md</strong>.
                      </div>
                    )}

                    {connectMsg && (
                      <div className="mt-3 text-[12px] font-bold" style={{
                        color: connectMsg.kind === "success" ? "var(--good)" : connectMsg.kind === "error" ? "var(--bad)" : "var(--warn)",
                      }}>{connectMsg.text}</div>
                    )}

                    {(conn?.connections?.length ?? 0) > 0 && (
                      <div className="mt-3 pt-3 border-t border-line text-[11.5px] text-mut font-medium">
                        Connected as {conn!.connections.map((c) => c.fbUserName || c.id).join(", ")} — use Disconnect on an account above to revoke access.
                      </div>
                    )}

                    <div className="mt-3 pt-3 border-t border-line flex items-center justify-between gap-3 flex-wrap">
                      <div className="text-[11.5px] text-mut font-medium">
                        <strong className="text-ink">No account access?</strong> Upload an Ads Manager export instead — same analysis, no credentials.
                      </div>
                      <Link href="/upload" className="btn-ghost shrink-0">Upload a report →</Link>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {syncMsg && <div className="mb-3 text-[12px] font-bold text-accent">{syncMsg}</div>}
            <div className="flex justify-between">
              <button onClick={() => setStep(0)} className="btn-ghost">← Back</button>
              <button disabled={!accountsChosen} onClick={() => setStep(2)} className="btn-primary">Next: Select campaign →</button>
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div key="c" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
            <div className="text-[13px] text-mut rounded-xl px-4 py-3 mb-3 border border-accent/25" style={{ background: "var(--accent-soft)" }}>🎯 Single platform — select <strong className="text-ink">one campaign</strong> to analyse in depth.</div>
            <div className="relative mb-3">
              <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-mut" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search campaigns…"
                className="w-full text-[13px] font-medium pl-9 pr-3 py-2.5 rounded-xl border border-line2 bg-surface outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" />
            </div>
            {singleList.length === 0 && (
              <div className="card p-4 mb-4 text-[13px] text-mut">
                {usingUpload
                  ? <>No campaigns could be read from that uploaded report. <Link href="/upload" className="text-accent font-bold">Check the column mapping</Link> and upload it again. {live?.liveError && <span className="text-bad">Reported error: {live.liveError}</span>}</>
                  : pool.length === 0
                    ? <>No campaigns are synced for <strong className="text-ink">{live?.account?.name ?? "this account"}</strong> yet. Use <strong className="text-ink">Sync now</strong> on the account above, or <Link href="/upload" className="text-accent font-bold">upload a report</Link>. {live?.liveError && <span className="text-bad">Reported error: {live.liveError}</span>}</>
                    : <>No campaigns match “{search}”.</>}
              </div>
            )}
            <div className="card overflow-hidden divide-y divide-line mb-5 max-h-[360px] overflow-y-auto">
              {singleList.map((c) => (
                <button key={c.id} onClick={() => setCamp(c.id)}
                  className={clsx("w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors", camp === c.id ? "" : "hover:bg-raised")}
                  style={camp === c.id ? { background: "var(--accent-soft)" } : undefined}>
                  <span className={clsx("w-[18px] h-[18px] rounded-full border-2 grid place-items-center shrink-0", camp === c.id ? "border-accent bg-accent" : "border-line2 bg-surface")}>
                    {camp === c.id && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </span>
                  <div className="min-w-0"><div className="text-[13.5px] font-bold truncate">{c.name}</div><div className="text-[11px] text-mut font-medium num">{curSym}{c.spend.toLocaleString()} · {c.roas > 0 ? `ROAS ${c.roas}x` : "revenue not reported"} · CTR {c.ctr}%</div></div>
                  <span className="ml-auto flex gap-1.5 items-center shrink-0"><PlatBadge p={c.platform} /><StatusBadge s={c.status} /></span>
                </button>
              ))}
            </div>
            <div className="flex justify-between">
              <button onClick={() => setStep(1)} className="btn-ghost">← Back</button>
              <button onClick={go} disabled={!pool.some((x) => x.id === camp)} className="btn-primary">Run analysis →</button>
            </div>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}
