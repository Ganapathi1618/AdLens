"use client";
import { useState, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, X, Send } from "lucide-react";
import { useApp } from "@/lib/store";
import { providerLabel } from "@/lib/llm";

interface Msg {
  role: "user" | "ai"; text: string; verified?: boolean; engine?: string; provider?: string;
  intent?: string; fallbackReason?: string | null;
  retrieval?: { live: boolean; refreshed: boolean; syncedAt: string | null };
}

const SUGGESTIONS = [
  "Why is CPM increasing?",
  "Why did CTR drop?",
  "Is creative fatigue occurring?",
  "Is the audience saturating?",
  "Which adset deserves more budget?",
  "What should we pause?",
  "What should we optimize first?",
  "Predict next week's performance",
];

function render(t: string) {
  return t
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
}

export default function AIPanel() {
  const { aiOpen, setAiOpen, campaignId, campaignName } = useApp();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bodyRef.current?.scrollTo({ top: 99999, behavior: "smooth" }); }, [msgs, aiOpen, busy]);
  useEffect(() => {
    if (campaignId) {
      const live = campaignId.startsWith("meta_");
      setMsgs([{ role: "ai", text: `Good morning 👋 **${campaignName}** loaded ${live ? "live from the Meta Graph API" : "from the daily snapshot (synced today 02:00)"}.\n\nI'm your performance analyst — I reason from the data, cite the numbers, and tell you what to do. Tap a question below or ask anything.` }]);
    }
  }, [campaignId, campaignName]);

  async function ask(q: string) {
    if (!q.trim() || !campaignId || busy) return;
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setInput(""); setBusy(true);
    try {
      const res = await fetch("/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ campaignId, question: q }) });
      // The pipeline returns a usable `reply` on failure too (an explanation of
      // what went wrong), so surface that rather than a raw status code.
      const data = await res.json().catch(() => null);
      if (!data) throw new Error(`API ${res.status}`);
      setMsgs((m) => [...m, {
        role: "ai", text: data.reply ?? "No answer was produced.",
        verified: data.verified, engine: data.engine, provider: data.provider,
        intent: data.intent, fallbackReason: data.fallbackReason ?? data.error ?? null,
        retrieval: data.retrieval,
      }]);
    } catch (err: any) {
      setMsgs((m) => [...m, { role: "ai", text: `Request failed — ${err?.message ?? "unknown error"}` }]);
    } finally { setBusy(false); }
  }

  if (!campaignId) return null;
  return (
    <>
      <motion.button onClick={() => setAiOpen(!aiOpen)} whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 text-white text-[13px] font-bold px-5 py-3 rounded-2xl shadow-hero"
        style={{ background: "var(--hero-grad)" }}>
        <Sparkles size={16} /> Ask AI
      </motion.button>
      <AnimatePresence>
        {aiOpen && (
          <motion.div initial={{ x: 480 }} animate={{ x: 0 }} exit={{ x: 480 }}
            transition={{ type: "spring", stiffness: 300, damping: 32 }}
            className="fixed top-0 right-0 bottom-0 w-[460px] z-50 glass border-l border-line shadow-lift flex flex-col">
            <div className="p-4 border-b border-line flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl grid place-items-center text-white shrink-0 shadow-hero" style={{ background: "var(--hero-grad)" }}>
                <Sparkles size={16} />
              </span>
              <div className="flex-1">
                <h3 className="font-bold text-[15px] leading-tight">AI Performance Analyst</h3>
                <div className="text-[11px] text-mut font-medium">Live · Meta Graph API · answers cite your data</div>
              </div>
              <button onClick={() => setAiOpen(false)} className="w-8 h-8 rounded-lg grid place-items-center text-mut hover:text-ink hover:bg-raised transition-colors"><X size={17} /></button>
            </div>
            <div ref={bodyRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {msgs.map((m, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  className={`flex gap-2.5 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                  <div className={`w-[28px] h-[28px] min-w-[28px] rounded-xl grid place-items-center text-[10px] font-bold ${m.role === "user" ? "bg-raised text-mut" : "text-white"}`}
                    style={m.role === "ai" ? { background: "var(--hero-grad)" } : undefined}>
                    {m.role === "user" ? "You" : <Sparkles size={12} />}
                  </div>
                  <div className="flex-1">
                    <div className={`text-[13px] leading-relaxed rounded-2xl px-3.5 py-2.5 ${m.role === "user" ? "text-white" : "bg-surface border border-line shadow-card"}`}
                      style={m.role === "user" ? { background: "var(--hero-grad)" } : undefined}
                      dangerouslySetInnerHTML={{ __html: render(m.text) }} />
                    {m.role === "ai" && m.verified === false && m.fallbackReason && (
                      <div className="text-[10px] mt-1.5 pl-1 font-semibold" style={{ color: "var(--warn)" }}>
                        No answer was generated — nothing was invented to fill the gap.
                      </div>
                    )}
                    {m.role === "ai" && m.verified && i > 0 && (
                      <div className="text-[10px] text-mut mt-1.5 pl-1 font-medium">
                        {m.intent === "platform"
                          ? "Platform knowledge — not based on your account data"
                          : m.intent === "out_of_scope"
                            ? "Outside scope — no answer attempted"
                            : "✓ every figure verified against the data snapshot"}
                        {m.engine === "pipeline" && <span className="ml-1.5 text-good">· {providerLabel(m.provider)} narrative</span>}
                        {m.engine === "llm" && <span className="ml-1.5 text-good">· {providerLabel(m.provider)} narrative</span>}
                        {m.engine === "glossary" && <span className="ml-1.5 text-mut">· built-in reference</span>}
                        {m.engine === "scope-guard" && <span className="ml-1.5 text-mut">· scope guard</span>}
                        {m.retrieval && (
                          <span className="ml-1.5 text-mut">
                            · {m.retrieval.live ? "live Meta data" : "uploaded report"}
                            {m.retrieval.refreshed && " (re-synced for this question)"}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
              {busy && (
                <div className="flex gap-2 items-center pl-10 text-[12px] text-mut font-medium">
                  <span className="flex gap-1">
                    {[0, 1, 2].map(i => <motion.span key={i} className="w-1.5 h-1.5 rounded-full bg-accent" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1, delay: i * 0.2 }} />)}
                  </span>
                  Fetching live campaign data, then analysing…
                </div>
              )}
            </div>
            <div className="px-4 pb-2.5">
              <div className="grid grid-cols-2 gap-1.5">
                {SUGGESTIONS.map((q) => (
                  <button key={q} onClick={() => ask(q)} disabled={busy}
                    className="text-[11px] font-semibold text-left px-3 py-2 rounded-xl border border-line2 text-mut hover:border-accent hover:text-accent transition-colors disabled:opacity-40">
                    {q}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-4 border-t border-line flex gap-2">
              <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask(input)}
                placeholder="Ask like you'd ask your media buyer…"
                className="flex-1 text-[13px] font-medium px-3.5 py-2.5 rounded-xl border border-line2 bg-surface outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all" />
              <button onClick={() => ask(input)} className="w-11 rounded-xl grid place-items-center text-white shadow-hero" style={{ background: "var(--hero-grad)" }}>
                <Send size={15} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
