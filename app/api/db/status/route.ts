// Powers a header badge: "12 campaigns · last synced 09:41".
// Safe in every state: no DB → { db:false }, no meta tables yet → counts stay 0.

import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { metaConfigured } from "@/lib/meta";

export const dynamic = "force-dynamic";
const NO_STORE = { headers: { "Cache-Control": "no-store, max-age=0" } };
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET() {
  try {
    const sql = getSql();

    // A database with no meta_* tables is a fresh deployment, not a failure:
    // nothing has been synced and nothing uploaded yet. Counting must not be
    // allowed to turn that into db:false, which reads as "Neon is unreachable".
    let metaCampaigns = 0;
    let uploads = 0;
    let lastSynced: string | null = null;
    let syncDetail: string | null = null;
    try {
      const m = (await sql`SELECT count(*)::int AS n FROM meta_campaigns`) as unknown as any[];
      metaCampaigns = m[0]?.n ?? 0;
      const s = (await sql`SELECT last_synced, detail FROM sync_log WHERE source = 'meta'`) as unknown as any[];
      lastSynced = s[0]?.last_synced ?? null;
      syncDetail = s[0]?.detail ?? null;
    } catch {
      // nothing synced yet
    }
    try {
      const u = (await sql`SELECT count(*)::int AS n FROM upload_batches`) as unknown as any[];
      uploads = u[0]?.n ?? 0;
    } catch {
      // nothing uploaded yet
    }

    // Probe the token cheaply so an expired/revoked token is reported here
    // rather than only surfacing when a sync is attempted.
    let tokenState: string | null = null;
    let tokenHint: string | null = null;
    if (metaConfigured()) {
      try {
        const { fetchAccountInfo } = await import("@/lib/meta");
        tokenState = (await fetchAccountInfo()) ? "ok" : "unknown";
      } catch (e: any) {
        tokenState = e?.kind ?? "error";
        tokenHint = e?.hint ?? e?.message ?? null;
      }
    }

    return NextResponse.json({
      db: true,
      tokenState,
      tokenHint,
      metaCampaigns,
      uploads,
      liveConfigured: metaConfigured(), // true once the two env vars exist in Vercel
      lastSynced,
      syncDetail,
    }, NO_STORE);
  } catch {
    return NextResponse.json({ db: false }, { status: 200, ...NO_STORE });
  }
}
