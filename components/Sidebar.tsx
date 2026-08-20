"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Home, LayoutGrid, FileText, BookOpen, Bell, Search, Zap, TrendingUp, Upload, LogOut } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import clsx from "clsx";
import { alerts } from "@/lib/data";
import { useDataMode } from "@/components/DataModeProvider";

const groups: { label: string; items: { href: string; label: string; icon: typeof Home; badge?: number }[] }[] = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Home", icon: Home },
      { href: "/overview", label: "Campaigns", icon: LayoutGrid },
      { href: "/check", label: "Account check", icon: Search },
      { href: "/upload", label: "Upload report", icon: Upload },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/reporting", label: "Reports", icon: FileText },
      { href: "/ledger", label: "Ledger", icon: BookOpen },
      { href: "/alerts", label: "Alerts", icon: Bell, badge: alerts.length },
    ],
  },
];

export default function Sidebar() {
  // Deployment-level, not "is a campaign currently selected". The old signal
  // read an in-memory store, so a reload made a real-data install look like
  // the demo and re-showed seeded figures.
  const { hasRealData, uploads, liveCampaigns } = useDataMode();
  const path = usePathname();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }

  return (
    <aside className="w-[232px] shrink-0 glass border-r border-line flex flex-col">
      <div className="px-4 pt-5 pb-4 flex items-center gap-3">
        <motion.div whileHover={{ rotate: -8, scale: 1.06 }}
          className="w-9 h-9 rounded-xl grid place-items-center text-white shadow-hero"
          style={{ background: "var(--hero-grad)" }}>
          <Zap size={17} strokeWidth={2.5} />
        </motion.div>
        <div>
          <div className="font-display text-[18px] leading-none tracking-tight">AdLens</div>
          <div className="text-[10px] font-semibold text-mut mt-1 uppercase tracking-widest">Ad Intelligence</div>
        </div>
      </div>

      <nav className="flex-1 px-2.5 pt-2 space-y-5 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="section-label px-2.5 mb-1.5">{g.label}</div>
            <div className="space-y-0.5">
              {g.items.map(({ href, label, icon: Icon, badge }) => {
                const active = href === "/" ? path === "/" : path.startsWith(href);
                return (
                  <Link key={href} href={href} className={clsx(
                    "relative flex items-center gap-2.5 px-2.5 py-[9px] rounded-xl text-[13px] font-semibold transition-colors",
                    active ? "text-accent" : "text-mut hover:text-ink hover:bg-raised")}>
                    {active && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-xl border border-accent/25"
                      style={{ background: "var(--accent-soft)" }}
                      transition={{ type: "spring", stiffness: 380, damping: 32 }} />}
                    <Icon size={16} className="relative z-10" strokeWidth={active ? 2.4 : 2} />
                    <span className="relative z-10">{label}</span>
                    {badge != null && badge > 0 && !hasRealData && (
                      <span className="relative z-10 ml-auto min-w-[20px] h-[20px] px-1 grid place-items-center rounded-full bg-bad text-white text-[10px] font-bold">{badge}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}

        {/* A figure nobody measured must never sit beside a real account's
            numbers, so this is seeded-demo only. Restore it for real data once
            the ledger records outcomes it can actually add up. */}
        {!hasRealData && (
          <div className="px-1 pt-1">
            <div className="rounded-2xl border border-line p-3.5" style={{ background: "var(--hero-grad-soft)" }}>
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-accent mb-1"><TrendingUp size={13} /> This week</div>
              <div className="text-[13px] font-bold num">+$4,210 recovered</div>
              <div className="text-[11px] text-mut leading-snug mt-0.5">from followed AI recommendations</div>
              <Link href="/ledger" className="text-[11px] font-bold text-accent inline-block mt-2 hover:underline">View ledger →</Link>
            </div>
          </div>
        )}
      </nav>

      <div className="p-3 border-t border-line flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-mut flex items-center gap-1.5 min-w-0">
          {hasRealData ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-good inline-block animate-pulse shrink-0" />
              <span className="truncate">
                {liveCampaigns > 0 && uploads > 0 ? "Live + uploaded"
                  : liveCampaigns > 0 ? "Live · Meta"
                    : `${uploads} uploaded report${uploads === 1 ? "" : "s"}`}
              </span>
            </>
          ) : (
            <><span className="w-1.5 h-1.5 rounded-full bg-accent inline-block shrink-0" />Demo data</>
          )}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <button onClick={signOut} title="Sign out"
            className="w-[26px] h-[26px] grid place-items-center rounded-lg border border-line2 text-mut hover:text-ink hover:bg-raised transition-colors">
            <LogOut size={13} />
          </button>
          <ThemeToggle />
        </span>
      </div>
    </aside>
  );
}
