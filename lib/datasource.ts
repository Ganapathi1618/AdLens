// ── Data layer abstraction ─────────────────────────────────────────
// One interface, one implementation: everything the app shows comes out of
// Postgres. Rows get there two ways — the Graph API sync (/api/sync/meta) or
// an uploaded report (/api/upload) — and both land in the same meta_* tables
// under their own ad_account_id, so there is nothing to route between.
//
// A second platform (Google, LinkedIn, Pinterest) is added by writing another
// class against this interface, not by branching inside this one.

import { Campaign, AdSet } from "./types";
import { loadLiveCampaigns, loadLiveCampaign, loadLiveSeries, loadLiveAdsets } from "./meta";

export interface DayPoint {
  day: string; ctr: number; cpa: number; spend: number; revenue: number;
  /** Raw counters — let the UI recompute exact KPIs for the selected date
   *  range instead of showing whole-window totals. */
  date?: string; impressions?: number; clicks?: number; conversions?: number;
  reach?: number; frequency?: number;
}

export interface DataSource {
  listCampaigns(): Promise<Campaign[]>;
  getCampaign(id: string): Promise<Campaign | null>;
  /** Optional window: ad set metrics must cover the SAME period as the KPIs. */
  getAdsets(campaignId: string, since?: string, until?: string): Promise<AdSet[]>;
  getDailySeries(campaignId: string): Promise<DayPoint[]>;
  /** On-demand fetch for a custom range — cached after first call. */
  fetchRange(campaignId: string, from: string, to: string): Promise<{ data: DayPoint[]; cached: boolean }>;
  snapshotInfo(): { syncedAt: string; mode: string };
}

// ── The live adapter: meta_* tables in Postgres → this interface ────
// Reads whatever the sync or an upload put there. No failure is swallowed:
// an empty array means "no rows", never "the query failed", and callers
// surface the error to the user rather than showing a plausible blank page.
export class LiveDataSource implements DataSource {
  private rangeCache = new Map<string, DayPoint[]>();

  async listCampaigns() { return loadLiveCampaigns(); }
  async getCampaign(id: string) { return loadLiveCampaign(id); }
  async getAdsets(campaignId: string, since?: string, until?: string): Promise<AdSet[]> {
    return loadLiveAdsets(campaignId, since, until);
  }
  async getDailySeries(campaignId: string) { return loadLiveSeries(campaignId); }

  async fetchRange(campaignId: string, from: string, to: string) {
    const key = `${campaignId}:${from}:${to}`;
    if (this.rangeCache.has(key)) return { data: this.rangeCache.get(key)!, cached: true };
    const data = await loadLiveSeries(campaignId, from, to);
    this.rangeCache.set(key, data);
    return { data, cached: false };
  }

  snapshotInfo() { return { syncedAt: "on-demand — see /api/db/status", mode: "live" }; }
}

export function getDataSource(): DataSource {
  return new LiveDataSource();
}

export const dataSource = getDataSource();
