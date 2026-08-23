"use client";
// Carries the server-resolved data mode to client components.
//
// The rule every consumer applies: **invented demo figures never render beside
// real numbers.** A pure demo install (no database, nothing uploaded) is
// unaffected and keeps every seeded screen exactly as it was.

import { createContext, useContext, useCallback } from "react";
import { useRouter } from "next/navigation";
import { DEMO_MODE, type DataMode } from "@/lib/dataMode";

interface DataModeContext extends DataMode {
  /** Re-resolve after an upload or a delete changes the answer. */
  refresh: () => void;
}

const Ctx = createContext<DataModeContext>({ ...DEMO_MODE, refresh: () => {} });

export function DataModeProvider({ value, children }: { value: DataMode; children: React.ReactNode }) {
  const router = useRouter();
  // The value is produced by the root server layout, so asking the router to
  // re-render is what re-resolves it — no second source of truth to drift.
  const refresh = useCallback(() => router.refresh(), [router]);
  return <Ctx.Provider value={{ ...value, refresh }}>{children}</Ctx.Provider>;
}

export function useDataMode(): DataModeContext {
  return useContext(Ctx);
}
