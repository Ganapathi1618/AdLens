// Threshold alerts, evaluated against the data this deployment actually holds.
//
// Previously this returned rows from a seeded `alerts` table while the alerts
// page ignored it entirely and rendered a hardcoded array, so no rule had ever
// run on real numbers. Now the rules in lib/alerts.ts are evaluated per
// campaign over its stored daily series.

import { NextResponse } from "next/server";
import { MergedDataSource } from "@/lib/datasource";
import { evaluateCampaign, sortAlerts, THRESHOLDS, type Alert } from "@/lib/alerts";
import { LIVE_PREFIX, setActiveAccount } from "@/lib/meta";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const NO_STORE = { headers: { "Cache-Control": "no-store, max-age=0" } };
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** Cap the fan-out: an agency account can hold hundreds of campaigns and each
 *  one costs a series read. The largest spenders are the ones worth alerting
 *  on, and the response says how many were examined. */
const MAX_CAMPAIGNS = 60;

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account");
  if (account) setActiveAccount(account);

  try {
    const src = new MergedDataSource();
    const all = await src.listCampaigns();
    const real = all.filter((c) => String(c.id).startsWith(LIVE_PREFIX));

    if (!real.length) {
      return NextResponse.json(
        { alerts: [], evaluated: 0, campaigns: 0, thresholds: THRESHOLDS, hasRealData: false },
        NO_STORE);
    }

    const ranked = real.slice().sort((a, b) => b.spend - a.spend).slice(0, MAX_CAMPAIGNS);

    const results = await Promise.all(ranked.map(async (c) => {
      try {
        return evaluateCampaign(c, await src.getDailySeries(c.id));
      } catch {
        // One unreadable campaign must not blank the whole page.
        return [] as Alert[];
      }
    }));

    const spendById = new Map(ranked.map((c) => [c.id, c.spend]));
    const alerts = sortAlerts(results.flat(), (id) => spendById.get(id) ?? 0);

    return NextResponse.json({
      alerts,
      evaluated: ranked.length,
      campaigns: real.length,
      truncated: real.length > ranked.length,
      thresholds: THRESHOLDS,
      hasRealData: true,
    }, NO_STORE);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not evaluate alerts", alerts: [] },
      { status: 500, ...NO_STORE });
  }
}
