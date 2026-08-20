// The ad accounts the picker shows, and the campaigns under the selected one.
//
// Three kinds of account appear here, in one list:
//   • uploaded reports  — no credential needed, read from upload_batches
//   • OAuth-connected   — a token the user granted via Connect with Facebook
//   • env-credential    — the single System User account, if configured
//
// Never throws: if Meta isn't configured or is unreachable, the uploaded
// accounts still come back, because an upload-only deployment is a supported
// way to run AdLens and must not depend on any Meta credential existing.

import { NextResponse } from "next/server";
import { MergedDataSource } from "@/lib/datasource";
import { fetchAccountInfo, metaConfigured, LIVE_PREFIX, setActiveAccount } from "@/lib/meta";
import { listBatches, isUploadAccount, type UploadBatch } from "@/lib/uploads";

export const dynamic = "force-dynamic";
const NO_STORE = { headers: { "Cache-Control": "no-store, max-age=0" } };
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** One row in the account picker. `kind` decides whether the UI offers
 *  "Sync now" (Graph) or "Re-upload" (file), and how it is labelled. */
interface PickerAccount {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  status: number;
  business: string | null;
  connectionId?: string | null;
  kind: "graph" | "upload";
  upload?: {
    filename: string;
    tier: UploadBatch["tier"];
    level: UploadBatch["level"];
    granularity: UploadBatch["granularity"];
    dateStart: string | null;
    dateEnd: string | null;
    days: number;
    campaigns: number;
    uploadedAt: string;
  };
}

const fromBatch = (b: UploadBatch): PickerAccount => ({
  id: b.id,
  name: b.label,
  currency: b.currency,
  timezone: b.timezone,
  status: 1,
  business: null,
  connectionId: null,
  kind: "upload",
  upload: {
    filename: b.filename, tier: b.tier, level: b.level, granularity: b.granularity,
    dateStart: b.dateStart, dateEnd: b.dateEnd, days: b.distinctDays,
    campaigns: b.campaigns, uploadedAt: b.uploadedAt,
  },
});

export async function GET(req: Request) {
  const requestedAccount = new URL(req.url).searchParams.get("account");

  // Uploaded batches are resolved first and unconditionally: they are the only
  // accounts available on a deployment with no Meta credential at all.
  const batches = await listBatches().catch(() => [] as UploadBatch[]);
  const uploadAccounts = batches.map(fromBatch);

  // ── an uploaded batch was selected: no Graph plumbing is involved ──
  if (requestedAccount && isUploadAccount(requestedAccount)) {
    setActiveAccount(requestedAccount);
    const batch = batches.find((b) => b.id === requestedAccount) ?? null;
    if (!batch) {
      return NextResponse.json({
        configured: uploadAccounts.length > 0,
        accessibleAccounts: uploadAccounts,
        campaigns: [],
        liveError: "that uploaded report no longer exists",
      }, NO_STORE);
    }
    let campaigns: Awaited<ReturnType<MergedDataSource["listCampaigns"]>> = [];
    let liveError: string | null = null;
    try {
      const all = await new MergedDataSource().listCampaigns();
      campaigns = all.filter((c) => String(c.id).startsWith(LIVE_PREFIX));
    } catch (e: unknown) {
      liveError = e instanceof Error ? e.message : "could not read that uploaded report";
    }
    return NextResponse.json({
      configured: true,
      account: { id: batch.id, name: batch.label, currency: batch.currency, timezone: batch.timezone },
      accessibleAccounts: uploadAccounts,
      activeAccount: batch.id,
      campaigns,
      lastSynced: batch.uploadedAt,
      upload: batch,
      liveError: liveError ?? (campaigns.length === 0 ? "no-campaigns-in-upload" : null),
    }, NO_STORE);
  }

  // ── otherwise the Meta path, with uploads listed alongside ──
  const { useConnectedAccount } = await import("@/lib/meta");
  await useConnectedAccount(requestedAccount);

  if (!metaConfigured()) {
    // No credential. That is not an error when reports have been uploaded —
    // it is simply the upload-only mode, and the picker must still work.
    return NextResponse.json({
      configured: uploadAccounts.length > 0,
      accessibleAccounts: uploadAccounts,
      campaigns: [],
      reason: "no-credentials",
      uploadsOnly: uploadAccounts.length > 0,
    }, NO_STORE);
  }

  try {
    // Discover everything this token can read. A client who grants Partner
    // access appears here on the next request — no config change, no redeploy.
    const { fetchAccessibleAdAccounts } = await import("@/lib/meta");
    let discovered: PickerAccount[] = [];
    let discoveryError: string | null = null;
    try {
      discovered = (await fetchAccessibleAdAccounts()).map((a) => ({ ...a, kind: "graph" as const }));
    } catch (e: unknown) {
      const err = e as { hint?: string; message?: string };
      discoveryError = err?.hint ?? err?.message ?? "could not list ad accounts";
    }

    // Accounts connected through OAuth are first-class here too.
    try {
      const { getConnectionStore } = await import("@/lib/connections");
      const connected = await getConnectionStore().listAccounts();
      const byId = new Map(connected.map((c) => [c.id, c.connectionId]));
      const seen = new Set(discovered.map((a) => String(a.id)));
      for (const c of connected) {
        if (!seen.has(c.id)) {
          discovered.push({
            id: c.id, name: c.name, currency: c.currency, timezone: c.timezone,
            business: c.business, status: c.status, kind: "graph",
          });
        }
      }
      discovered = discovered.map((a) => ({ ...a, connectionId: byId.get(String(a.id)) ?? null }));
    } catch { /* connection store unavailable — env credentials still work */ }

    if (requestedAccount) setActiveAccount(requestedAccount);

    const account = await fetchAccountInfo();
    // Deliberately NOT caught here: if live data can't be read we must say so
    // rather than quietly returning an empty list that looks like "no campaigns".
    const all = await new MergedDataSource().listCampaigns();
    const campaigns = all.filter((c) => String(c.id).startsWith(LIVE_PREFIX));
    const { getLastSynced } = await import("@/lib/meta");
    const lastSynced = await getLastSynced();
    return NextResponse.json({
      configured: true,
      account,
      // Every ad account reachable with the current credential, plus every
      // report uploaded to this deployment.
      accessibleAccounts: [...uploadAccounts, ...discovered],
      discoveryError,
      activeAccount: account?.id ?? null,
      campaigns,
      lastSynced,
      liveError: campaigns.length === 0 ? "no-live-campaigns-synced" : null,
    }, NO_STORE);
  } catch (e: unknown) {
    // Credentials exist but live data is unreachable — an explicit error state,
    // not a silent downgrade to demo data. Uploads are unaffected, so they stay.
    return NextResponse.json({
      configured: true,
      accessibleAccounts: uploadAccounts,
      campaigns: [],
      liveError: e instanceof Error ? e.message : "live data unavailable",
    }, NO_STORE);
  }
}
