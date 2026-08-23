"use client";
// The login screen. The root layout renders it without the sidebar or the AI
// panel (see the x-pathname header set in middleware.ts), so this is a plain
// centred page rather than an overlay fighting the app chrome for the viewport.

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Zap, Lock } from "lucide-react";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error ?? "Could not sign in.");
      // A full navigation, not a client push: the middleware must re-run and
      // see the new cookie before any protected page renders.
      window.location.href = next.startsWith("/") ? next : "/";
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-[380px]">
        <div className="flex items-center gap-3 mb-6">
          <span className="w-10 h-10 rounded-xl grid place-items-center text-white shadow-hero"
            style={{ background: "var(--hero-grad)" }}>
            <Zap size={19} strokeWidth={2.5} />
          </span>
          <div>
            <div className="font-display text-[20px] leading-none tracking-tight">AdLens</div>
            <div className="text-[10px] font-semibold text-mut mt-1 uppercase tracking-widest">Ad Intelligence</div>
          </div>
        </div>

        <form onSubmit={submit} className="card p-6">
          <div className="flex items-center gap-2 mb-1.5">
            <Lock size={14} className="text-accent" />
            <span className="text-[14px] font-bold">This workspace is private</span>
          </div>
          <p className="text-[12.5px] text-mut font-medium leading-relaxed mb-4">
            It shows live ad account data, so it needs the workspace password.
          </p>

          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Workspace password"
            className="w-full text-[13.5px] font-semibold px-3.5 py-2.5 rounded-xl border border-line2 bg-surface outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />

          {error && <div className="mt-3 text-[12.5px] font-bold text-bad">{error}</div>}

          <button type="submit" disabled={busy || !password} className="btn-primary w-full mt-4 justify-center">
            {busy ? "Checking…" : "Sign in"}
          </button>
        </form>
      </motion.div>
    </div>
  );
}

export default function Login() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
