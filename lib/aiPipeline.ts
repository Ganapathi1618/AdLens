// ── AI query pipeline ───────────────────────────────────────────────
// Every account question runs the same ordered stages, and the model is only
// invoked at the very end, on data that was actually retrieved:
//
//   1. parse     — what is being asked, about which entities, on which metrics
//   2. resolve   — turn those names into real campaign / ad set ids
//   3. fetch     — pull live Meta data (syncing first when it is stale)
//   4. context   — assemble a structured, citable evidence pack
//   5. analyze   — compute findings from that pack
//   6. generate  — write the answer, grounded ONLY in the pack
//
// There is deliberately NO template path: if the data cannot be retrieved, or
// the model is unreachable, the pipeline reports that instead of inventing an
// answer from canned prose.

import { buildEvidence, analyze, verifyCitations, ANALYST_SYSTEM, type Evidence } from "./reasoning";
import { generateNarrative } from "./llm";
import { dataSource } from "./datasource";
import { LIVE_PREFIX, getLastSynced, useConnectedAccount } from "./meta";
import { isUploadedCampaign } from "./uploads";
import type { Campaign, AdSet } from "./data";

export type QueryKind =
  | "diagnose"    // why is X doing Y
  | "performance" // how is X doing
  | "compare"     // A vs B
  | "delivery"    // why did X stop / not spending
  | "recommend"   // what should I do
  | "general";

export interface ParsedQuery {
  kind: QueryKind;
  /** Entity names mentioned in the question, matched against real names. */
  entities: string[];
  /** Metrics explicitly asked about, if any. */
  metrics: string[];
  /** True when the question is about a specific day/period ("today"). */
  timeSensitive: boolean;
  raw: string;
}

const METRIC_WORDS: Record<string, string[]> = {
  spend: ["spend", "spending", "budget", "cost", "burn"],
  ctr: ["ctr", "click through", "click-through", "clicks"],
  cpc: ["cpc", "cost per click"],
  cpm: ["cpm", "cost per mille", "cost per thousand"],
  roas: ["roas", "return on ad spend", "revenue"],
  cpa: ["cpa", "cost per acquisition", "cost per result", "cost per conversion"],
  conversions: ["conversion", "conversions", "results", "purchases", "leads"],
  frequency: ["frequency", "freq", "fatigue"],
  reach: ["reach", "impressions"],
  pacing: ["pacing", "pace", "delivery", "delivering", "underspend", "overspend"],
};

/* ── Stage 1: parse ───────────────────────────────────────────────── */
export function parseQuery(question: string, knownEntities: string[]): ParsedQuery {
  const raw = String(question ?? "");
  const q = raw.toLowerCase();

  let kind: QueryKind = "general";
  // Order matters. Each test claims phrasing the later ones would also match:
  // "what should I pause" is a decision request, not a delivery question, and
  // "why did X stop delivering" is a delivery question, not a generic "why".
  if (/\bvs\b|\bversus\b|\bcompare\b|\bcompared to\b|\bbetter\b/.test(q)) kind = "compare";
  else if (/\bshould i\b|\brecommend|\bwhat do i\b|\bnext step|\bwhat would you\b|\bhelp me\b/.test(q)) kind = "recommend";
  else if (
    /\bstop(?:ped|ping|s)?\b|\bnot\s+(?:deliver|spend|runn?)|\bno\s+deliver|isn'?t\s+(?:deliver|spend|runn?)|spend(?:ing)?\s+less|under\s?spend|over\s?spend|\bdeliver(?:y|ing)\b|\bpacing\b/
      .test(q)
  ) kind = "delivery";
  else if (/^why\b|\bwhy\b|\bdrop|\bfell|\bdecline|\bworse|\bincreas/.test(q)) kind = "diagnose";
  else if (/how is|how are|performance|performing|doing|status|summary|overview/.test(q)) kind = "performance";
  else if (/\bscale\b|\bpause\b|\bfix\b|\baction\b/.test(q)) kind = "recommend";

  // Entity matching is done against REAL names from the account, so a partial
  // or lower-case mention still resolves to the right object.
  const entities = knownEntities.filter((n) => {
    const name = n.toLowerCase();
    if (!name) return false;
    if (q.includes(name)) return true;
    // Also match on a distinctive leading fragment ("Summer Sale" in a longer name).
    const head = name.split(/[—\-–|(]/)[0].trim();
    return head.length >= 4 && q.includes(head);
  });

  const metrics = Object.entries(METRIC_WORDS)
    .filter(([, words]) => words.some((w) => q.includes(w)))
    .map(([m]) => m);

  const timeSensitive = /today|yesterday|right now|currently|this morning|last hour/.test(q);

  return { kind, entities, metrics, timeSensitive, raw };
}

/* ── Stage 2 + 3: resolve targets and retrieve live data ──────────── */

export interface RetrievalResult {
  ok: boolean;
  campaign?: Campaign;
  adsets?: AdSet[];
  /** Ad sets the question specifically named, when it named any. */
  focusedAdsets?: AdSet[];
  isLive: boolean;
  /** True when the campaign's rows came from an uploaded file, not a sync. */
  isUpload: boolean;
  syncedAt: string | null;
  refreshed: boolean;
  error?: string;
}

/** How stale synced Meta data may be before a question triggers a re-sync.
 *  Time-sensitive questions ("today") demand fresher data than general ones. */
const STALE_MS = 30 * 60 * 1000;
const STALE_MS_TIME_SENSITIVE = 5 * 60 * 1000;

/**
 * Stage 3 — retrieve. For a live campaign this re-syncs from the Meta Graph API
 * when the stored snapshot is older than the freshness budget, so the answer is
 * always built on data that was actually fetched from Meta.
 */
export async function retrieveData(
  campaignId: string,
  parsed: ParsedQuery,
  origin: string,
): Promise<RetrievalResult> {
  const isLive = String(campaignId).startsWith(LIVE_PREFIX);
  let refreshed = false;
  let syncedAt: string | null = null;

  if (isLive) {
    // Make sure the Graph layer is holding this account's credentials.
    await useConnectedAccount(null).catch(() => false);

    try {
      syncedAt = await getLastSynced();
    } catch {
      syncedAt = null;
    }

    const budget = parsed.timeSensitive ? STALE_MS_TIME_SENSITIVE : STALE_MS;
    const age = syncedAt ? Date.now() - new Date(syncedAt).getTime() : Infinity;

    if (age > budget) {
      // Campaign-scoped sync: pulls this campaign, its ad sets and ads straight
      // from Meta. Deliberately awaited — no answer is produced until it lands.
      try {
        const bare = String(campaignId).slice(LIVE_PREFIX.length);
        const res = await fetch(
          `${origin}/api/sync/meta?campaign=${encodeURIComponent(bare)}&preset=last_30&t=${Date.now()}`,
          { cache: "no-store" },
        );
        const body = await res.json().catch(() => ({}));
        if (body?.synced) {
          refreshed = true;
          syncedAt = new Date().toISOString();
        } else if (age === Infinity) {
          // Never synced AND the refresh failed — there is nothing to answer from.
          return {
            ok: false, isLive, isUpload: false, syncedAt, refreshed: false,
            error: body?.error ?? body?.reason ?? "Could not retrieve data from the Meta Ads API.",
          };
        }
      } catch (e: unknown) {
        if (age === Infinity) {
          return {
            ok: false, isLive, isUpload: false, syncedAt, refreshed: false,
            error: e instanceof Error ? e.message : "Meta Ads API request failed.",
          };
        }
        // A refresh failure on top of usable data is acceptable; the answer
        // will carry the snapshot timestamp so staleness is visible.
      }
    }
  }

  const campaign = await dataSource.getCampaign(campaignId);
  if (!campaign) {
    return { ok: false, isLive, isUpload: false, syncedAt, refreshed, error: "Campaign not found." };
  }
  const adsets = await dataSource.getAdsets(campaignId);

  const wanted = parsed.entities.map((e) => e.toLowerCase());
  const focusedAdsets = wanted.length
    ? adsets.filter((a) => wanted.some((w) => a.name.toLowerCase().includes(w) || w.includes(a.name.toLowerCase())))
    : [];

  return { ok: true, campaign, adsets, focusedAdsets, isLive, isUpload: isUploadedCampaign(campaign), syncedAt, refreshed };
}

/* ── Stage 4: context ─────────────────────────────────────────────── */

export interface QueryContext {
  evidence: Evidence;
  parsed: ParsedQuery;
  retrieval: RetrievalResult;
  /** Findings computed from the evidence — the analysis the model must use. */
  findings: ReturnType<typeof analyze>;
  /** True when the evidence pack was reused from a previous question about the
   *  same campaign and snapshot, rather than rebuilt. */
  cached: boolean;
}

// Evidence assembly is the expensive part (campaign + ad sets + ads + daily
// series). Follow-up questions about the SAME campaign reuse it instead of
// rebuilding: the underlying snapshot cannot have changed unless a sync ran,
// and `syncedAt` is part of the key, so a re-sync invalidates the entry.
const CONTEXT_TTL_MS = 10 * 60 * 1000;
const contextCache = new Map<string, { at: number; evidence: Evidence }>();

function cacheKey(campaignId: string, syncedAt: string | null) {
  return `${campaignId}::${syncedAt ?? "static"}`;
}

/** Dropped when an account is disconnected or a sync writes new rows. */
export function invalidateContextCache(campaignId?: string) {
  if (!campaignId) return contextCache.clear();
  Array.from(contextCache.keys()).forEach((k) => { if (k.startsWith(`${campaignId}::`)) contextCache.delete(k); });
}

export async function buildContext(
  campaignId: string,
  parsed: ParsedQuery,
  retrieval: RetrievalResult,
): Promise<QueryContext | null> {
  const key = cacheKey(campaignId, retrieval.syncedAt);
  const hit = contextCache.get(key);

  let evidence: Evidence | null;
  let cached = false;
  if (hit && Date.now() - hit.at < CONTEXT_TTL_MS && !retrieval.refreshed) {
    evidence = hit.evidence;          // same campaign, same snapshot → reuse
    cached = true;
  } else {
    evidence = await buildEvidence(campaignId);
    if (evidence) {
      contextCache.set(key, { at: Date.now(), evidence });
      // Bound the map — this is a per-instance cache, not a store.
      if (contextCache.size > 50) {
        const oldest = Array.from(contextCache.keys())[0];
        if (oldest) contextCache.delete(oldest);
      }
    }
  }
  if (!evidence) return null;

  // Pacing and status are part of the answerable surface, so they travel with
  // the evidence rather than being re-derived in prose.
  const c = retrieval.campaign;
  if (c) {
    (evidence as Evidence & { pacing?: unknown; status?: string }).pacing =
      c.pacingDetail ?? { percent: c.pacing, basis: "unknown" };
    (evidence as Evidence & { status?: string }).status = c.status;
  }
  if (retrieval.adsets?.length) {
    (evidence as Evidence & { adsetPacing?: unknown }).adsetPacing = retrieval.adsets.map((a) => ({
      name: a.name,
      status: a.status ?? null,
      pacing: a.pacingDetail ?? null,
    }));
  }

  return { evidence, parsed, retrieval, findings: analyze(parsed.raw, evidence), cached };
}

/* ── Stage 6: generate ────────────────────────────────────────────── */

export type PipelineAnswer =
  | {
      ok: true;
      reply: string;
      provider?: string;
      model?: string;
      stages: string[];
      retrieval: { live: boolean; refreshed: boolean; syncedAt: string | null; cached: boolean };
      verified: boolean;
    }
  | { ok: false; reason: string; detail?: string; stages: string[] };

/** Focuses the model on the kind of question actually asked. */
function taskHint(parsed: ParsedQuery): string {
  switch (parsed.kind) {
    case "delivery":
      return "The user is asking why delivery or spend stopped or dropped. Lead with status, pacing basis (daily vs lifetime), budget headroom and schedule — an ad set that is Paused or out of budget explains it outright.";
    case "compare":
      return "The user is comparing entities. Put them side by side on the same metrics, state which wins on which metric, and say plainly whether the difference is meaningful given the result volumes.";
    case "diagnose":
      return "The user wants a cause. Rank the likely causes by evidence strength and say what would confirm each.";
    case "recommend":
      return "The user wants a decision. Give specific, sized actions and the expected effect.";
    case "performance":
      return "The user wants a status read. Lead with the headline numbers and the single thing most worth attention.";
    default:
      return "Answer the question directly from the evidence.";
  }
}

/**
 * How the data reached us, in words the model is allowed to repeat.
 *
 * An uploaded report is a frozen extract; describing it as a live API read
 * would let the narrative imply the numbers are current when they are not.
 */
export function sourceLabel(r: { isLive: boolean; isUpload: boolean }): string {
  if (r.isUpload) return "uploaded report file (a frozen extract, not a live read)";
  return r.isLive ? "Meta Ads API (live)" : "seeded dataset";
}

export async function generateAnswer(ctx: QueryContext, stages: string[]): Promise<PipelineAnswer> {
  const payload = {
    question: ctx.parsed.raw,
    questionKind: ctx.parsed.kind,
    focusMetrics: ctx.parsed.metrics,
    namedEntities: ctx.parsed.entities,
    dataFreshness: {
      source: sourceLabel(ctx.retrieval),
      syncedAt: ctx.retrieval.syncedAt,
      refreshedForThisQuestion: ctx.retrieval.refreshed,
    },
    evidence: ctx.evidence,
    computedFindings: ctx.findings,
  };

  const system = `${ANALYST_SYSTEM}\n\n${taskHint(ctx.parsed)}`;
  const user = `Data retrieved for this question:\n${JSON.stringify(payload)}\n\nQuestion: ${ctx.parsed.raw}`;

  const llm = await generateNarrative(system, user);
  stages.push("generate");

  if (!llm.ok) {
    // No canned answer. Saying nothing truthful is better than saying something
    // fabricated, and the caller surfaces this as an explicit error state.
    return {
      ok: false,
      reason: llm.reason === "no-api-key" ? "no-model-configured" : "model-unreachable",
      detail: llm.detail,
      stages,
    };
  }

  let text = llm.text;
  let check = verifyCitations(text, ctx.evidence);
  stages.push("verify");

  // A first-pass miss is usually a figure the model derived or rounded, not one
  // it invented. Rejecting outright left the user with nothing at all, so give
  // exactly one corrective attempt that names the offending figures. Tolerance
  // is unchanged — the retry must pass the same check to be shown.
  if (!check.ok) {
    const offending = Array.from(new Set(check.unverified.concat(check.misattributed))).slice(0, 12);
    const retry = await generateNarrative(
      system,
      `${user}\n\nYour previous answer was REJECTED: these figures could not be traced to the data above — ${offending.join(", ")}.\n` +
        `Rewrite it using ONLY figures that appear in the data. Do not derive, estimate or extrapolate new numbers, and do not attribute one ad set's figure to another. ` +
        `Where you need a number you do not have, describe the point qualitatively instead.\n\nPrevious answer:\n${text}`,
    );
    stages.push("retry", "verify");
    if (retry.ok) {
      const recheck = verifyCitations(retry.text, ctx.evidence);
      if (recheck.ok) { text = retry.text; check = recheck; }
    }
  }

  if (!check.ok) {
    return {
      ok: false,
      reason: "citation-check-failed",
      detail: [...check.unverified, ...check.misattributed].join(", "),
      stages,
    };
  }

  return {
    ok: true,
    reply: text,
    provider: llm.provider,
    model: llm.model,
    stages,
    retrieval: {
      live: ctx.retrieval.isLive, refreshed: ctx.retrieval.refreshed,
      syncedAt: ctx.retrieval.syncedAt, cached: ctx.cached,
    },
    verified: true,
  };
}

/** Entity names for the account currently on screen — used by stage 1 so a
 *  bare or partial name still resolves. */
export async function knownEntityNames(campaignId: string): Promise<string[]> {
  try {
    const c = await dataSource.getCampaign(campaignId);
    if (!c) return [];
    const sets = await dataSource.getAdsets(campaignId);
    return [c.name, ...sets.map((s) => s.name), ...sets.flatMap((s) => s.ads.map((a) => a.name))].filter(Boolean);
  } catch {
    return [];
  }
}
