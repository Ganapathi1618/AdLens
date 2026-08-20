// ── Data layer abstraction ─────────────────────────────────────────
// Requirement: swap Mock → Meta/Google/LinkedIn/Pinterest with minimal changes.
// Everything (reasoning engine, chat, reports) reads through this interface.

import { campaigns, adsetsFor, getCampaign, series30, Campaign, AdSet } from "./data";
import { loadLiveCampaigns, loadLiveCampaign, loadLiveSeries, loadLiveAdsets, LIVE_PREFIX } from "./meta";

export interface DayPoint {
  day: string; ctr: number; cpa: number; spend: number; revenue: number;
  /** Live-only raw counters — let the UI recompute exact KPIs for the
   *  selected date range instead of showing whole-window totals. */
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

// ── Mock implementation (current prototype) ────────────────────────
class MockDataSource implements DataSource {
  private rangeCache = new Map<string, DayPoint[]>();

  async listCampaigns() { return campaigns; }
  async getCampaign(id: string) { return getCampaign(id) ?? null; }
  async getAdsets(campaignId: string) { return adsetsFor(campaignId); }
  async getDailySeries(campaignId: string) { return series30(campaignId); }

  async fetchRange(campaignId: string, from: string, to: string) {
    const key = `${campaignId}:${from}:${to}`;
    if (this.rangeCache.has(key)) return { data: this.rangeCache.get(key)!, cached: true };
    // Simulates hitting the platform API for ONLY the requested slice
    const data = series30(campaignId);
    this.rangeCache.set(key, data);
    return { data, cached: false };
  }

  snapshotInfo() { return { syncedAt: "Today 02:00", mode: "daily-snapshot" }; }
}

// ── Live adapter: Meta Graph API → Neon → this interface ───────────
// Implemented for Checkpoint 2. Data flow: /api/sync/meta pulls from the
// Graph API into meta_* tables; this class reads those tables back out and
// maps them into the app's own Campaign/DayPoint shapes (see lib/meta.ts).
// Live ids are prefixed "meta_" so they can never collide with seeded ids.
export class MetaDataSource implements DataSource {
  private rangeCache = new Map<string, DayPoint[]>();
  constructor(private token: string, private accountId: string) {}

  async listCampaigns() { return loadLiveCampaigns(); }
  async getCampaign(id: string) { return loadLiveCampaign(id); }

  // Live adset drill-down, backed by meta_adsets / meta_ads (see lib/meta.ts).
  // Returns [] when adset sync hasn't run — the UI's empty states handle that.
  async getAdsets(campaignId: string, since?: string, until?: string): Promise<AdSet[]> {
    // Deliberately NOT caught: an empty array must mean "no adsets", never
    // "the query failed". Callers surface the error to the user.
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

  snapshotInfo() { return { syncedAt: "on-demand — see /api/db/status", mode: "meta-live" }; }
}

// ── Merged: live Meta rows stacked ON TOP of the seeded portfolio ───
// The demo-safe mode: any live failure degrades to seeded-only, never to a
// broken page. Requests route by id prefix, so both worlds coexist.
export class MergedDataSource implements DataSource {
  private mock = new MockDataSource();
  private meta = new MetaDataSource(
    process.env.META_ACCESS_TOKEN ?? "",
    process.env.META_AD_ACCOUNT_ID ?? ""
  );

  private isLive(id: string) { return id.startsWith(LIVE_PREFIX); }

  async listCampaigns() {
    const live = await this.meta.listCampaigns().catch(() => [] as Campaign[]);
    const seeded = await this.mock.listCampaigns();
    return [...live, ...seeded];
  }
  async getCampaign(id: string) {
    return this.isLive(id)
      ? this.meta.getCampaign(id).catch(() => null)
      : this.mock.getCampaign(id);
  }
  async getAdsets(campaignId: string, since?: string, until?: string) {
    return this.isLive(campaignId)
      ? this.meta.getAdsets(campaignId, since, until)
      : this.mock.getAdsets(campaignId);
  }
  async getDailySeries(campaignId: string) {
    return this.isLive(campaignId)
      ? this.meta.getDailySeries(campaignId).catch(() => [] as DayPoint[])
      : this.mock.getDailySeries(campaignId);
  }
  async fetchRange(campaignId: string, from: string, to: string) {
    return this.isLive(campaignId)
      ? this.meta.fetchRange(campaignId, from, to).catch(() => ({ data: [] as DayPoint[], cached: false }))
      : this.mock.fetchRange(campaignId, from, to);
  }
  snapshotInfo() { return { syncedAt: "Today 02:00", mode: "merged (seeded + meta-live)" }; }
}

export function getDataSource(): DataSource {
  switch (process.env.DATA_SOURCE) {
    case "meta": // pure live — only synced Meta campaigns
      return new MetaDataSource(process.env.META_ACCESS_TOKEN ?? "", process.env.META_AD_ACCOUNT_ID ?? "");
    case "merged":
      return new MergedDataSource();
    case "mock": // explicit demo-only
      return new MockDataSource();
    default:
      // MergedDataSource routes by id prefix (meta_* → live, everything else →
      // seeded), so Demo Mode and Live Mode both work without an env var.
      //
      // DATABASE_URL alone is enough to select it. Uploaded reports live in the
      // same tables under their own ad account and carry the same meta_ prefix,
      // but a deployment that only ever uploads has no Meta credentials — gating
      // on those would leave the reasoning engine, the AI pipeline and
      // /api/db/periods reading the seeded dataset and reporting every uploaded
      // campaign as "not found". Any live failure still degrades to seeded.
      return (process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID) || process.env.DATABASE_URL
        ? new MergedDataSource()
        : new MockDataSource();
  }
}

export const dataSource = getDataSource();
