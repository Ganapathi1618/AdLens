import type { CampaignStatus } from "./types";

// ── Meta status → display status ────────────────────────────────────
// Meta reports two fields. `status` is what the user set; `effective_status`
// is what the platform is actually doing, and it is the one that must reach
// the UI: a campaign set ACTIVE whose ad sets are all paused is not delivering,
// and an ARCHIVED campaign is not "Paused".
//
// Everything not ACTIVE used to collapse to "Paused", which is why archived
// campaigns showed as active/paused incorrectly.

export function mapMetaStatus(effectiveStatus?: string | null, status?: string | null): CampaignStatus {
  const s = String(effectiveStatus || status || "").toUpperCase();
  switch (s) {
    case "ACTIVE":
      return "Active";
    case "PAUSED":
    case "CAMPAIGN_PAUSED":
    case "ADSET_PAUSED":
      return "Paused";
    case "ARCHIVED":
      return "Archived";
    case "DELETED":
      return "Deleted";
    case "PENDING_REVIEW":
    case "IN_PROCESS":
    case "PENDING_BILLING_INFO":
      return "In Review";
    case "DISAPPROVED":
    case "WITH_ISSUES":
    case "PREAPPROVED":
      return "In Review";
    case "CAMPAIGN_GROUP_PAUSED":
      return "Paused";
    default:
      // An unmapped value must not silently become "Active".
      return s ? "Incomplete" : "Paused";
  }
}

/** Only Active campaigns can be delivering. Used for the account-level
 *  "No active campaigns" state and for health scoring. */
export const isDelivering = (s: CampaignStatus) => s === "Active";

/** Statuses that should be hidden from portfolio views by default —
 *  archived/deleted campaigns are history, not inventory. */
export const isArchivedLike = (s: CampaignStatus) => s === "Archived" || s === "Deleted";

export const STATUS_TONE: Record<CampaignStatus, "good" | "mut" | "warn" | "bad"> = {
  Active: "good",
  Paused: "mut",
  Archived: "mut",
  Deleted: "mut",
  "In Review": "warn",
  Incomplete: "warn",
};
