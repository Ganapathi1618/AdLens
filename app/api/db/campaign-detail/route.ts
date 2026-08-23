// Campaign + adsets + daily series for ONE campaign, through the DataSource seam.
// Used by the analysis page for live ("meta_") ids. Seeded ids keep their existing
// synchronous path, so nothing else in the app is affected by this route.

import { NextResponse } from "next/server";
import { LiveDataSource } from "@/lib/datasource";
import { resolveRange, type PresetKey } from "@/lib/daterange";

export const dynamic = "force-dynamic";
const NO_STORE = { headers: { "Cache-Control": "no-store, max-age=0" } };
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400, ...NO_STORE });

  // The selected range is resolved server-side in the AD ACCOUNT's timezone and
  // applied as a real date filter — not by taking the last N rows, which spans
  // more calendar days than requested whenever a day has no delivery.
  // Explicit account selection — the platform is not tied to one configured
  // account, so any account the credential can reach may be requested.
  const accountParam = url.searchParams.get("account");
  const meta = await import("@/lib/meta");
  const isLive = id.startsWith("meta_");
  if (accountParam) meta.setActiveAccount(accountParam);
  // The analysis page links here with a campaign id alone. Resolving the
  // owning account from the row is what makes that work for an OAuth account
  // or an uploaded report — without it the scope falls back to the env
  // account, which an upload-only deployment does not have.
  else if (isLive) await meta.ensureAccountForCampaign(id.slice("meta_".length));
  const tz = isLive ? (await meta.fetchAccountInfo())?.timezone ?? "UTC" : "UTC";
  const presetKey = (url.searchParams.get("preset") || "last_30") as PresetKey;
  const resolved = resolveRange(presetKey, tz, {
    since: url.searchParams.get("since"),
    until: url.searchParams.get("until"),
  });
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error, kind: "invalid_range" }, { status: 400, ...NO_STORE });
  }
  const range = resolved;
  try {
    const src = new LiveDataSource();
    const campaign = await src.getCampaign(id);
    if (!campaign) return NextResponse.json({ error: "not found" }, { status: 404, ...NO_STORE });
    // Adsets and series are reported independently so one failing doesn't hide
    // the other, and a failure is reported as an error rather than as emptiness.
    let adsets: Awaited<ReturnType<typeof src.getAdsets>> = [];
    let adsetError: string | null = null;
    try {
      // Same window as the series and the KPIs — never all-time.
      adsets = await src.getAdsets(id, isLive ? range.since : undefined, isLive ? range.until : undefined);
    } catch (e: any) {
      adsetError = e?.message ?? "adset query failed";
      console.error("getAdsets failed for", id, adsetError);
    }
    let series: Awaited<ReturnType<typeof src.getDailySeries>> = [];
    let seriesError: string | null = null;
    try {
      // Range-filtered at the source for live campaigns.
      series = isLive
        ? (await src.fetchRange(id, range.since, range.until)).data
        : await src.getDailySeries(id);
    } catch (e: any) {
      seriesError = e?.message ?? "series query failed";
      console.error("getDailySeries failed for", id, seriesError);
    }
    // When a campaign has no adsets, report what the account DOES have so the
    // UI can explain why, instead of showing a dead end.
    let adsetsInAccount: Awaited<ReturnType<typeof import("@/lib/meta").listLiveAdsetsBrief>> = [];
    if (!adsets.length && String(id).startsWith("meta_")) {
      const { listLiveAdsetsBrief } = await import("@/lib/meta");
      adsetsInAccount = await listLiveAdsetsBrief();
    }
    // Coverage: what was ASKED FOR vs what is actually stored. A short series
    // must be visibly incomplete, never silently presented as the full period.
    const dates = series.map((d) => d.date ?? "").filter(Boolean);
    const coverage = {
      requested: { since: range.since, until: range.until, days: range.days },
      returned: {
        since: dates[0] ?? null,
        until: dates[dates.length - 1] ?? null,
        days: dates.length,
      },
      complete: dates.length >= range.days,
      empty: dates.length === 0,
    };

    // Where these numbers came from, carried to the UI so an uploaded report
    // can never be presented with a "Live · Meta Graph API" label, and so the
    // metrics its file does not contain render as "not reported" rather than 0.
    const { getBatch, isUploadAccount } = await import("@/lib/uploads");
    const activeAccount = meta.currentAccountId();
    const batch = isLive && isUploadAccount(activeAccount) ? await getBatch(activeAccount) : null;
    const provenance = batch
      ? {
          kind: "upload" as const,
          label: `Uploaded · ${batch.filename}`,
          detail: `${batch.rowsParsed.toLocaleString()} rows · ${batch.dateStart ?? "?"} to ${batch.dateEnd ?? "?"} · uploaded ${new Date(batch.uploadedAt).toLocaleDateString()}`,
          tier: batch.tier,
          capabilities: batch.capabilities,
          warnings: batch.warnings,
          uploadedAt: batch.uploadedAt,
          accountId: batch.id,
        }
      : { kind: "graph" as const, label: "Live · Meta Graph API", detail: null, tier: null, capabilities: [], warnings: [], uploadedAt: null, accountId: activeAccount };

    return NextResponse.json({
      campaign,
      adsets,
      series,
      adsetError,
      seriesError,
      adsetsInAccount,
      range,
      coverage,
      provenance,
      timezone: tz,
      currency: (batch?.currency ?? campaign.currency) || process.env.META_CURRENCY || "USD",
    }, NO_STORE);
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 500, ...NO_STORE });
  }
}
