// ── What kind of data does this deployment hold? (server) ───────────
// Resolved on the server and handed to the client through a provider, so the
// first paint is already correct.
//
// Fetching it client-side instead means the very first render cannot know the
// answer, which either flashes the seeded demo brief on a real account — the
// exact thing this signal exists to prevent — or flashes a loading state over
// the demo. Neither is acceptable, so it is computed before anything renders.

import { getSql } from "./db";
import { metaConfigured } from "./meta";

export interface DataMode {
  /** True when anything a user could mistake for their own numbers exists. */
  hasRealData: boolean;
  uploads: number;
  liveCampaigns: number;
  liveConfigured: boolean;
}

export const DEMO_MODE: DataMode = {
  hasRealData: false, uploads: 0, liveCampaigns: 0, liveConfigured: false,
};

/** Two counts and an env check. Cheap enough for the root layout. */
export async function getDataMode(): Promise<DataMode> {
  let uploads = 0;
  let liveCampaigns = 0;

  try {
    const sql = getSql();
    try {
      const r = (await sql`SELECT count(*)::int AS n FROM upload_batches`) as unknown as { n: number }[];
      uploads = r[0]?.n ?? 0;
    } catch { /* no uploads table yet */ }
    try {
      const r = (await sql`
        SELECT count(*)::int AS n FROM meta_campaigns
        WHERE COALESCE(data_source, 'graph') = 'graph'`) as unknown as { n: number }[];
      liveCampaigns = r[0]?.n ?? 0;
    } catch {
      try {
        const r = (await sql`SELECT count(*)::int AS n FROM meta_campaigns`) as unknown as { n: number }[];
        liveCampaigns = r[0]?.n ?? 0;
      } catch { /* no meta tables yet */ }
    }
  } catch {
    // No database at all — a pure demo deployment, which is a supported mode.
    return DEMO_MODE;
  }

  return {
    hasRealData: uploads > 0 || liveCampaigns > 0,
    uploads,
    liveCampaigns,
    liveConfigured: metaConfigured(),
  };
}
