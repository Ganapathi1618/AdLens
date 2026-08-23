// One live adset by id, through the seam. Live adset ids are "meta_<adsetId>" and
// carry their parent campaign id, so we resolve the campaign then find the adset.

import { NextResponse } from "next/server";
import { LiveDataSource } from "@/lib/datasource";
import { getSql } from "@/lib/db";
import { LIVE_PREFIX } from "@/lib/meta";

export const dynamic = "force-dynamic";
const NO_STORE = { headers: { "Cache-Control": "no-store, max-age=0" } };
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id.startsWith(LIVE_PREFIX)) return NextResponse.json({ error: "not a live adset" }, { status: 400, ...NO_STORE });
  try {
    // find the parent campaign for this adset
    const rows = (await getSql()`
      SELECT s.campaign_id, c.name AS campaign_name
      FROM meta_adsets s
      LEFT JOIN meta_campaigns c ON c.id = s.campaign_id
      WHERE s.id = ${id.slice(LIVE_PREFIX.length)} LIMIT 1`) as unknown as any[];
    if (!rows.length) return NextResponse.json({ error: "not found" }, { status: 404, ...NO_STORE });
    const campaignId = `${LIVE_PREFIX}${rows[0].campaign_id}`;
    const adsets = await new LiveDataSource().getAdsets(campaignId);
    const adset = adsets.find((a) => a.id === id) ?? null;
    if (!adset) return NextResponse.json({ error: "not found" }, { status: 404, ...NO_STORE });
    // Currency belongs to the ad account the rows came from — an uploaded
    // report carries its own, and META_CURRENCY must never override it.
    const campaign = await new LiveDataSource().getCampaign(campaignId);
    return NextResponse.json({
      adset, campaignId,
      campaignName: rows[0].campaign_name ?? null,
      currency: campaign?.currency ?? process.env.META_CURRENCY ?? "USD",
    }, NO_STORE);
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 500, ...NO_STORE });
  }
}
