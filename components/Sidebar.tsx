"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Home, LayoutGrid, FileText, BookOpen, Bell, Search, Zap, Upload, LogOut, CalendarRange } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import clsx from "clsx";

const groups: { label: string; items: { href: string; label: string; icon: typeof Home }[] }[] = [
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
      { href: "/monthly", label: "Month over month", icon: CalendarRange },
      { href: "/ledger", label: "Ledger", icon: BookOpen },
      { href: "/alerts", label: "Alerts", icon: Bell },
    ],
  },
];

export default function Sidebar() {
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
              {g.items.map(({ href, label, icon: Icon }) => {
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
                  </Link>
                );
              })}
            </div>
          </div>
        ))}

      </nav>

      <div className="p-3 border-t border-line flex items-center justify-end gap-1.5">
        <button onClick={signOut} title="Sign out"
          className="w-[26px] h-[26px] grid place-items-center rounded-lg border border-line2 text-mut hover:text-ink hover:bg-raised transition-colors">
          <LogOut size={13} />
        </button>
        <ThemeToggle />
      </div>
    </aside>
  );
}
