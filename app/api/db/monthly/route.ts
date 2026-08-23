// Month-over-month report for one account.
//
// Works the same for a synced Meta account and an uploaded batch: both read
// through the same DataSource seam, so the report has no idea where the rows
// came from.

import { NextResponse } from "next/server";
import { MergedDataSource } from "@/lib/datasource";
import { LIVE_PREFIX, setActiveAccount, fetchAccountInfo } from "@/lib/meta";
import { buildMonthlyReport, defaultMonths, monthsInSeries, type Alignment, type CampaignSeries } from "@/lib/monthly";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const NO_STORE = { headers: { "Cache-Control": "no-store, max-age=0" } };
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** An agency batch can hold hundreds of campaigns; each costs a series read. */
const MAX_CAMPAIGNS = 200;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account");
  const currentParam = url.searchParams.get("current");
  const previousParam = url.searchParams.get("previous");
  const alignParam = url.searchParams.get("align");

  for (const [name, v] of [["current", currentParam], ["previous", previousParam]] as const) {
    if (v && !MONTH.test(v)) {
      return NextResponse.json({ error: `"${name}" must look like 2026-08.` }, { status: 400, ...NO_STORE });
    }
  }
  const alignment: Alignment | "auto" =
    alignParam === "full" ? "full" : alignParam === "same-days" ? "same-days" : "auto";

  if (account) setActiveAccount(account);

  try {
    const src = new MergedDataSource();
    const all = await src.listCampaigns();
    const real = all.filter((c) => String(c.id).startsWith(LIVE_PREFIX));

    if (!real.length) {
      return NextResponse.json({
        error: "No campaigns found for this account. Upload a report or sync an ad account first.",
        available: [],
      }, { status: 404, ...NO_STORE });
    }

    const ranked = real.slice().sort((a, b) => b.spend - a.spend).slice(0, MAX_CAMPAIGNS);
    const campaigns: CampaignSeries[] = await Promise.all(
      ranked.map(async (c) => ({
        id: c.id,
        name: c.name,
        // Unfiltered: the report picks its own months out of the full history.
        series: await src.getDailySeries(c.id).catch(() => []),
      })));

    const available = monthsInSeries(campaigns.flatMap((c) => c.series))
      .map((m) => ({ key: m.key, label: m.label, daysWithData: m.daysWithData, complete: m.complete }));

    if (available.length < 2 && !(currentParam && previousParam)) {
      return NextResponse.json({
        error: available.length === 0
          ? "This account has no dated data to compare."
          : `Only ${available[0].label} is present. Add a report covering another month to compare them.`,
        available,
        needsMoreData: true,
      }, { status: 409, ...NO_STORE });
    }

    const fallback = defaultMonths(available);
    const current = currentParam ?? fallback?.current;
    const previous = previousParam ?? fallback?.previous;
    if (!current || !previous) {
      return NextResponse.json({ error: "Could not choose two months to compare.", available }, { status: 409, ...NO_STORE });
    }
    if (current === previous) {
      return NextResponse.json({ error: "Pick two different months.", available }, { status: 400, ...NO_STORE });
    }

    const info = await fetchAccountInfo().catch(() => null);
    const currency = info?.currency
      ?? ranked.find((c) => c.currency)?.currency
      ?? process.env.META_CURRENCY
      ?? "USD";

    const report = buildMonthlyReport(campaigns, current, previous, currency, alignment);

    // Provenance, so a report built from uploaded files says which files.
    const { getBatch, isUploadAccount } = await import("@/lib/uploads");
    const { currentAccountId } = await import("@/lib/meta");
    const active = currentAccountId();
    const batch = isUploadAccount(active) ? await getBatch(active) : null;

    return NextResponse.json({
      ...report,
      account: {
        id: active,
        name: batch?.label ?? info?.name ?? "Ad account",
        kind: batch ? "upload" : "graph",
        sources: batch?.sources ?? [],
      },
      evaluated: ranked.length,
      totalCampaigns: real.length,
      truncated: real.length > ranked.length,
    }, NO_STORE);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not build the report" },
      { status: 500, ...NO_STORE });
  }
}
