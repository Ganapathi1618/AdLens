// Visit /api/sync/meta in the browser to pull live Meta data into Neon.
// Optional: ?days=7 to backfill a week (default trailing window is 3 days —
// Meta restates conversions for ~72h, so we always re-pull the tail).
// Without META_ACCESS_TOKEN + META_AD_ACCOUNT_ID this route is a graceful no-op.

import { NextResponse } from "next/server";
import { resolveRange, todayInTz, addDays, toISO, parseISO, type PresetKey, type Range, type RangeError } from "@/lib/daterange";
import type { FetchWindow } from "@/lib/meta";
import { getSql } from "@/lib/db";
import {
  metaConfigured, fetchMetaCampaignList, fetchMetaInsights,
  fetchAdsetsForCampaign, fetchAdsForAdset,
  fetchMetaAdsetInsights, fetchMetaAdInsights,
  fetchAccountCurrency,
} from "@/lib/meta";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);

  // Optional lock: set SYNC_SECRET in Vercel, then call /api/sync/meta?key=THAT_VALUE
  if (process.env.SYNC_SECRET && url.searchParams.get("key") !== process.env.SYNC_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Graceful no-op: without the two env vars this endpoint can never break anything.
  // Range selection drives extraction. Accepts a named preset
  // (?preset=last_7) or an explicit custom window (?since=&until=). The legacy
  // ?days=N still works and is converted to an explicit window below.
  // Explicit account selection — the platform is not tied to one configured
  // account, so any account the credential can reach may be requested.
  const accountParam = url.searchParams.get("account");

  // An uploaded report is stored as a synthetic ad account. Syncing one is
  // meaningless — there is no token behind it — and a sync that fell through
  // to the env account here would write another account's campaigns into the
  // uploaded batch. Refuse explicitly rather than relying on that not happening.
  {
    const { isUploadAccount } = await import("@/lib/uploads");
    if (isUploadAccount(accountParam)) {
      return NextResponse.json({
        synced: false,
        kind: "upload_account",
        error: "That is an uploaded report, not a connected ad account. To refresh it, upload a new export from the Uploads page.",
      }, { status: 400 });
    }
  }

  // Prefer an OAuth-connected credential for this account; setActiveAccount
  // alone would pair the requested account with the wrong (env) token.
  const { useConnectedAccount, setActiveAccount } = await import("@/lib/meta");
  const viaOAuth = await useConnectedAccount(accountParam);
  if (accountParam && !viaOAuth) setActiveAccount(accountParam);
  const presetParam = url.searchParams.get("preset") ?? "";
  const sinceParam = url.searchParams.get("since");
  const untilParam = url.searchParams.get("until");
  const daysParam = Number(url.searchParams.get("days"));
  // Scope: whole account by default, or a single campaign with ?campaign=<id>.
  // Campaign-level sync is much faster and is what the in-app refresh uses.
  const campaignParam = (url.searchParams.get("campaign") ?? "").replace(/^meta_/, "");

  // Validate user input BEFORE anything else. An invalid range is a bad
  // request regardless of credentials, and reporting the wrong problem sends
  // the caller chasing the wrong fix. This check needs no timezone.
  if (sinceParam || untilParam) {
    const a2 = parseISO(sinceParam ?? "");
    const b2 = parseISO(untilParam ?? "");
    if (!a2 || !b2) {
      return NextResponse.json(
        { synced: false, kind: "invalid_range", error: "A custom range needs both since and until as YYYY-MM-DD." },
        { status: 400 });
    }
    if (toISO(a2) > toISO(b2)) {
      return NextResponse.json(
        { synced: false, kind: "invalid_range", error: `Start date (${toISO(a2)}) is after end date (${toISO(b2)}).` },
        { status: 400 });
    }
  }

  // Graceful no-op: without the two env vars this endpoint can never break anything.
  if (!metaConfigured()) {
    return NextResponse.json({
      synced: false,
      mode: "not-configured",
      reason: "META_ACCESS_TOKEN / META_AD_ACCOUNT_ID not set — connect an ad account, or upload a report instead.",
    });
  }



  const { resetTruncations, getTruncations, GraphError, fetchAccountInfo: acctInfoFn } = await import("@/lib/meta");
  resetTruncations();

  // Resolve the window ONCE, in the ad account's timezone, and use that same
  // resolved range for the platform fetch, the DB write and the response — so
  // UI, backend and API cannot disagree about the period.
  const tz = (await acctInfoFn())?.timezone ?? "UTC";
  let resolved: Range | RangeError;
  if (presetParam) {
    resolved = resolveRange(presetParam as PresetKey, tz, { since: sinceParam, until: untilParam });
  } else if (sinceParam && untilParam) {
    resolved = resolveRange("custom", tz, { since: sinceParam, until: untilParam });
  } else {
    // Legacy ?days=N becomes an explicit window ending today, so one code path
    // serves every caller and the response always reports real boundaries.
    const n2 = Math.min(Math.max(daysParam || 3, 1), 90);
    const today = todayInTz(tz);
    resolved = resolveRange("custom", tz, { since: toISO(addDays(today, -(n2 - 1))), until: toISO(today) });
  }
  if ("error" in resolved) {
    return NextResponse.json({ synced: false, error: resolved.error, kind: "invalid_range" }, { status: 400 });
  }
  const range = resolved;
  const window: FetchWindow = range.metaPreset
    ? { preset: range.metaPreset }
    : { since: range.since, until: range.until };

  try {
    const sql = getSql();
    // Add any columns this code writes that an older db/meta-sync.sql lacks
    // (ad_account_id, actions, cpm/reach/frequency/conv_value, creative fields).
    await (await import("@/lib/meta")).ensureMetaSchema();
    // Every row written is stamped with the ad account it came from, so live
    // reads can be scoped and two accounts' data can never be mixed.
    // Must be the account actually being read (OAuth-connected or env), never
    // the env var — otherwise an OAuth sync would stamp rows with someone
    // else's account id and the two accounts' data would cross.
    const acctId = (await import("@/lib/meta")).currentAccountId();

    // 1. Campaign shells (id, name, status, objective, daily budget)
    const allShells = await fetchMetaCampaignList();
    const shells = campaignParam ? allShells.filter((c) => c.id === campaignParam) : allShells;
    if (campaignParam && !shells.length) {
      return NextResponse.json(
        { synced: false, kind: "not_found", error: `Campaign ${campaignParam} is not in this ad account.` },
        { status: 404 });
    }
    for (const c of shells) {
      await sql`
        INSERT INTO meta_campaigns (id, name, status, effective_status, objective,
                                    daily_budget, lifetime_budget, start_time, stop_time,
                                    ad_account_id, updated_at)
        VALUES (${c.id}, ${c.name}, ${c.status}, ${c.effectiveStatus}, ${c.objective},
                ${c.dailyBudget}, ${c.lifetimeBudget}, ${c.startTime}, ${c.stopTime},
                ${acctId}, now())
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, status = EXCLUDED.status,
            effective_status = EXCLUDED.effective_status,
            objective = EXCLUDED.objective, daily_budget = EXCLUDED.daily_budget,
            lifetime_budget = EXCLUDED.lifetime_budget,
            start_time = EXCLUDED.start_time, stop_time = EXCLUDED.stop_time,
            ad_account_id = EXCLUDED.ad_account_id, updated_at = now()`;
    }
    const known = new Set(shells.map((c) => c.id));

    // 2. Daily metrics for the trailing window (upsert = re-pulled days overwrite cleanly)
    // Objective decides what counts as a "result" (purchases vs landing page
    // views vs leads), so the numbers match Ads Manager's Results column.
    const objectiveById = Object.fromEntries(shells.map((c) => [c.id, c.objective]));
    const dominantObjective = shells[0]?.objective;
    const rows = await fetchMetaInsights(window, objectiveById);
    let written = 0;
    for (const r of rows) {
      if (!known.has(r.campaign_id)) continue; // deleted-campaign guard (FK safety)
      await sql`
        INSERT INTO meta_daily_metrics
          (campaign_id, date, spend, impressions, clicks, conversions, ctr, cpc, roas,
           cpm, reach, frequency, conv_value, actions)
        VALUES
          (${r.campaign_id}, ${r.date}, ${r.spend}, ${r.impressions}, ${r.clicks},
           ${r.conversions}, ${r.ctr}, ${r.cpc}, ${r.roas},
           ${r.cpm}, ${r.reach}, ${r.frequency}, ${r.convValue}, ${JSON.stringify(r.actions ?? {})}::jsonb)
        ON CONFLICT (campaign_id, date) DO UPDATE
        SET spend = EXCLUDED.spend, impressions = EXCLUDED.impressions,
            clicks = EXCLUDED.clicks, conversions = EXCLUDED.conversions,
            ctr = EXCLUDED.ctr, cpc = EXCLUDED.cpc, roas = EXCLUDED.roas,
            cpm = EXCLUDED.cpm, reach = EXCLUDED.reach,
            frequency = EXCLUDED.frequency, conv_value = EXCLUDED.conv_value,
            actions = EXCLUDED.actions`;
      written++;
    }

    // 3. Ad sets, walked PER CAMPAIGN: campaign → /{campaign_id}/adsets.
    //    Parentage comes from the edge we queried, so an ad set can never be
    //    orphaned by a missing or mismatched campaign_id in the payload.
    const adsetShells: Awaited<ReturnType<typeof fetchAdsetsForCampaign>> = [];
    // Errors are COLLECTED, never swallowed: an empty result must be
    // distinguishable from a failed call, or the sync lies about succeeding.
    const fetchErrors: { scope: string; id: string; error: string }[] = [];
    for (const c of shells) {
      try {
        adsetShells.push(...(await fetchAdsetsForCampaign(c.id)));
      } catch (e: any) {
        fetchErrors.push({ scope: "adsets", id: c.id, error: e?.message ?? "unknown" });
      }
    }
    let adsetsWritten = 0;
    for (const s of adsetShells) {
      await sql`
        INSERT INTO meta_adsets (id, campaign_id, name, status, effective_status, daily_budget,
                                 lifetime_budget, start_time, stop_time,
                                 optimization_goal, destination_type, updated_at)
        VALUES (${s.id}, ${s.campaignId}, ${s.name}, ${s.status}, ${s.effectiveStatus}, ${s.dailyBudget},
                ${s.lifetimeBudget}, ${s.startTime}, ${s.stopTime},
                ${s.optimizationGoal}, ${s.destinationType}, now())
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, status = EXCLUDED.status,
            effective_status = EXCLUDED.effective_status,
            lifetime_budget = EXCLUDED.lifetime_budget,
            start_time = EXCLUDED.start_time, stop_time = EXCLUDED.stop_time,
            campaign_id = EXCLUDED.campaign_id, daily_budget = EXCLUDED.daily_budget,
            optimization_goal = EXCLUDED.optimization_goal,
            destination_type = EXCLUDED.destination_type,
            updated_at = now()`;
      adsetsWritten++;
    }
    const knownAdsets = new Set(adsetShells.map((s) => s.id));

    // Remove ad sets that Meta no longer reports under ANY of our campaigns.
    // These are leftovers from the older account-wide fetch and are exactly
    // what makes a campaign show "no ad sets" while rows exist in the table.
    // DESTRUCTIVE — only safe when every campaign's ad sets were fetched
    // successfully. If any fetch failed, `knownAdsets` is incomplete and this
    // would delete real rows.
    let orphansRemoved = 0;
    const cleanupSafe = fetchErrors.filter((e) => e.scope === "adsets").length === 0 && adsetShells.length > 0;
    try {
      if (!cleanupSafe) throw new Error("skipped — incomplete fetch");
      const stored = (await sql`
        SELECT s.id FROM meta_adsets s
        JOIN meta_campaigns c ON c.id = s.campaign_id AND c.ad_account_id = ${acctId}`) as unknown as any[];
      for (const row of stored) {
        if (!knownAdsets.has(String(row.id))) {
          await sql`DELETE FROM meta_adsets WHERE id = ${String(row.id)}`;
          orphansRemoved++;
        }
      }
    } catch {
      // non-fatal: sync still succeeds without the cleanup
    }

    // Results are counted PER AD SET using its own optimisation goal and
    // destination — a WhatsApp ad set and a website ad set in the same
    // campaign do not share a definition of "result".
    const adsetRows: Awaited<ReturnType<typeof fetchMetaAdsetInsights>> = [];
    const goalById = Object.fromEntries(adsetShells.map((a) => [a.id, a]));
    const goalGroups = Array.from(new Set(adsetShells.map((a) => `${a.optimizationGoal}|${a.destinationType}`)));
    for (const grp of goalGroups.length ? goalGroups : [""]) {
      const [og, dt] = grp.split("|");
      const rows2 = await fetchMetaAdsetInsights(window, dominantObjective, og, dt);
      const idsInGroup = new Set(adsetShells.filter((a) => `${a.optimizationGoal}|${a.destinationType}` === grp).map((a) => a.id));
      adsetRows.push(...rows2.filter((r) => idsInGroup.size === 0 || idsInGroup.has(r.entity_id)));
    }
    void goalById;
    let adsetDayRows = 0;
    for (const r of adsetRows) {
      if (!knownAdsets.has(r.entity_id)) continue;
      await sql`
        INSERT INTO meta_adset_daily
          (adset_id, date, spend, impressions, clicks, conversions, ctr, cpc, roas, frequency, reach, actions)
        VALUES (${r.entity_id}, ${r.date}, ${r.spend}, ${r.impressions}, ${r.clicks},
                ${r.conversions}, ${r.ctr}, ${r.cpc}, ${r.roas}, ${r.frequency}, ${r.reach},
                ${JSON.stringify(r.actions ?? {})}::jsonb)
        ON CONFLICT (adset_id, date) DO UPDATE
        SET spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
            conversions = EXCLUDED.conversions, ctr = EXCLUDED.ctr, cpc = EXCLUDED.cpc,
            roas = EXCLUDED.roas, frequency = EXCLUDED.frequency, reach = EXCLUDED.reach,
            actions = EXCLUDED.actions`;
      adsetDayRows++;
    }

    // 4. Ads, walked PER AD SET: ad set → /{adset_id}/ads. Same guarantee.
    const adShells: Awaited<ReturnType<typeof fetchAdsForAdset>> = [];
    for (const s of adsetShells) {
      try {
        adShells.push(...(await fetchAdsForAdset(s.id)));
      } catch (e: any) {
        fetchErrors.push({ scope: "ads", id: s.id, error: e?.message ?? "unknown" });
      }
    }
    let adsWritten = 0;
    for (const a of adShells) {
      await sql`
        INSERT INTO meta_ads (id, adset_id, name, format, status, thumbnail_url, title, body, permalink, updated_at)
        VALUES (${a.id}, ${a.adsetId}, ${a.name}, ${a.format}, ${a.status},
                ${a.thumbnail}, ${a.title}, ${a.body}, ${a.permalink}, now())
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, format = EXCLUDED.format, status = EXCLUDED.status,
            adset_id = EXCLUDED.adset_id, thumbnail_url = EXCLUDED.thumbnail_url,
            title = EXCLUDED.title, body = EXCLUDED.body, permalink = EXCLUDED.permalink,
            updated_at = now()`;
      adsWritten++;
    }
    const knownAds = new Set(adShells.map((a) => a.id));

    // Ads inherit their ad set's definition of a result.
    const adRows: Awaited<ReturnType<typeof fetchMetaAdInsights>> = [];
    const adsetOf = Object.fromEntries(adShells.map((a) => [a.id, a.adsetId]));
    for (const grp of goalGroups.length ? goalGroups : [""]) {
      const [og, dt] = grp.split("|");
      const rows3 = await fetchMetaAdInsights(window, dominantObjective, og, dt);
      const setIds = new Set(adsetShells.filter((a) => `${a.optimizationGoal}|${a.destinationType}` === grp).map((a) => a.id));
      adRows.push(...rows3.filter((r) => setIds.size === 0 || setIds.has(String(adsetOf[r.entity_id] ?? ""))));
    }
    let adDayRows = 0;
    for (const r of adRows) {
      if (!knownAds.has(r.entity_id)) continue;
      await sql`
        INSERT INTO meta_ad_daily
          (ad_id, date, spend, impressions, clicks, conversions, ctr, roas, frequency, actions)
        VALUES (${r.entity_id}, ${r.date}, ${r.spend}, ${r.impressions}, ${r.clicks},
                ${r.conversions}, ${r.ctr}, ${r.roas}, ${r.frequency},
                ${JSON.stringify(r.actions ?? {})}::jsonb)
        ON CONFLICT (ad_id, date) DO UPDATE
        SET spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
            conversions = EXCLUDED.conversions, ctr = EXCLUDED.ctr,
            roas = EXCLUDED.roas, frequency = EXCLUDED.frequency,
            actions = EXCLUDED.actions`;
      adDayRows++;
    }

    // 5. Stamp the "last synced" badge (currency included so the UI can label money correctly)
    const { fetchAccountInfo } = await import("@/lib/meta");
    const acctInfo = await fetchAccountInfo(true); // force-refresh the cached identity
    const currency = acctInfo?.currency ?? (await fetchAccountCurrency());
    const detail = `${shells.length} campaigns · ${written} day-rows · ${adsetsWritten} adsets · ${adsWritten} ads · ${currency} · ${range.label}`;
    // Global marker (backwards compatible) plus a per-account row, so each
    // connected account reports its own freshness.
    for (const src of ["meta", `meta:${acctId}`]) {
      await sql`
        INSERT INTO sync_log (source, last_synced, detail)
        VALUES (${src}, now(), ${detail})
        ON CONFLICT (source) DO UPDATE
        SET last_synced = now(), detail = EXCLUDED.detail`;
    }

    return NextResponse.json({
      synced: true,
      scope: campaignParam ? { level: "campaign", campaignId: campaignParam } : { level: "account", accountId: acctId },
      // Per-campaign breakdown so the response itself proves the hierarchy.
      orphansRemoved,
      cleanupSkipped: !cleanupSafe,
      // Non-empty means some pages were NOT fetched: the result is incomplete
      // and must not be presented as the full account.
      truncated: getTruncations(),
      timezone: range.timezone,
      // The exact window used, echoed back so caller, platform fetch and
      // stored rows can be confirmed to agree.
      range: { key: range.key, since: range.since, until: range.until, days: range.days, label: range.label, metaPreset: range.metaPreset },
      fetchErrors,          // ← if ad sets are missing, the reason is HERE
      hierarchy: shells.map((c) => ({
        campaign: c.name,
        campaignId: c.id,
        adsets: adsetShells.filter((s) => s.campaignId === c.id).length,
        ads: adShells.filter((a) => adsetShells.some((s) => s.id === a.adsetId && s.campaignId === c.id)).length,
      })),
      campaigns: shells.length,
      dayRows: written,
      adsets: adsetsWritten,
      adsetDayRows,
      ads: adsWritten,
      adDayRows,
      currency,
      trailingDays: range.days,
    });
  } catch (e: any) {
    // A failed sync NEVER touches rows already in the DB — the app keeps
    // serving what it has. The failure is classified so the cause is actionable.
    const isGraph = e instanceof GraphError;
    return NextResponse.json({
      synced: false,
      error: e?.message ?? "sync failed",
      ...(isGraph ? { kind: e.kind, code: e.code, subcode: e.subcode, retryable: e.retryable, hint: e.hint } : {}),
    }, { status: isGraph && e.kind === "auth" ? 401 : 500 });
  }
}
