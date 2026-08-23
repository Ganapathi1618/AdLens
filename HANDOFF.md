# AdLens — Engineering Handoff

Read this before changing anything. It captures **current state**, not just design.
Written for another engineer or AI assistant picking this up cold.

---

## 1. What AdLens is

An AI performance analyst for ad campaigns. Rules detect problems from metrics;
an LLM only *explains* what the rules found; every number the LLM writes is
verified against the evidence pack before it is shown. Scored 88/100 at
Checkpoint 1. The reviewer's headline note: *"the rules-do-detection /
AI-does-explanation split is actually built, not just claimed."*

**Never break that split.** The LLM must not be allowed to originate a metric.

## 2. Two modes, one app

| | Demo Mode | Live Mode |
|---|---|---|
| Source | `lib/data.ts` — 55 seeded campaigns, deterministic | Meta Graph API → Neon Postgres |
| Campaign IDs | `summer-sale`, `c7`, … | `meta_<raw Meta id>` |
| Chosen by | any id **without** the `meta_` prefix | id **starting** `meta_` |

Routing is by ID prefix, in `MergedDataSource` (`lib/datasource.ts`). There is no
global mode flag — the prefix *is* the mode. Demo Mode must keep working
untouched; it is the graded CP1 deliverable.

## 2b. Uploaded reports (third mode)

A deployment with **no Meta credentials at all** is a supported way to run
AdLens. `/upload` takes an Ads Manager export and stores it as a **synthetic ad
account** in the same `meta_*` tables the sync writes to.

```
.csv / .xlsx
  → lib/xlsx.ts | lib/csv.ts        bytes → rows of strings, then coercion
  → lib/adsReport.ts                column mapping, capability tiering, normalisation
  → lib/uploads.ts                  UNNEST bulk insert into meta_* under ad_account_id
  → the SAME readers as live data   loadLiveCampaigns / loadLiveSeries / loadLiveAdsets
```

**Why the same tables, not new ones.** Every live read in `lib/meta.ts` is
already scoped by `ad_account_id`. Reusing them means the reasoning engine,
pacing, period comparison, the AI pipeline and every page work on uploads with
no second implementation to keep in step. Two properties make it safe:

- Upload account ids are `up` + 12 hex. Real Meta ad account ids are **digits
  only**, so they cannot collide, and `/api/sync/meta` refuses an upload id
  outright.
- `meta_campaigns.data_source` is `'upload'` vs `'graph'`, which is what makes
  provenance survive into the UI (`Campaign.note`) and into the AI's context.

**Invariants — do not break these:**

1. **A missing column is never a zero.** No impressions column means no CTR, not
   a CTR of 0%. The batch's `capabilities` list carries what is unavailable and
   why, and it is rendered on the analysis page and fed to the model.
2. **Uploaded data is never labelled live.** `snapshot.mode` is
   `uploaded-report`, and `lib/aiPipeline.ts:sourceLabel()` tells the model it is
   a frozen extract.
3. **Ratios are recomputed from totals**, never averaged across rows. Per-day
   `roas` is stored as value ÷ spend because `loadLiveAdsets` rebuilds ad set
   revenue as `Σ roas × spend`.
4. **Lifetime budgets are pro-rated** to a daily rate across their flight
   (`dailyRate()` in `lib/adsReport.ts`). Pacing an 18-day window against an
   eight-month lifetime expectation reports a meaningless few percent; without
   flight dates pacing is reported unknown rather than guessed.

Two changes were needed in shared code to make this work, and they fix live data
too:

- `ensureAccountForCampaign()` (`lib/meta.ts`) resolves the owning account from
  the campaign row. `/api/db/campaign-detail` and `/api/db/periods` are called
  with a campaign id alone, and previously fell back to `META_AD_ACCOUNT_ID` —
  returning nothing for any campaign that account did not own.
- `getDataSource()` selects `MergedDataSource` on `DATABASE_URL` alone. Gating
  it on Meta env vars left the reasoning engine reading the seeded dataset.

Tests: `npm run test:upload` (parsing/mapping always; persistence with
`TEST_DATABASE_URL`, which exercises the real bulk inserts and read-back).

## 2c. Month-over-month reports

`lib/monthly.ts` compares **calendar months**; `lib/periods.ts` compares rolling
28-day windows. Both are wanted — "is this trending down" is a different
question from "how did August do against July" — so neither replaces the other.

Two decisions to preserve:

1. **Partial months are aligned, not compared raw.** An 18-day August against a
   full July reports spend down ~42%, which measures the export, not the
   campaigns. Unequal months are cut to the same day-of-month span and the
   report states it. Two COMPLETE months always compare in full, even at 30 vs
   31 days — truncating there would silently drop the 31st.
2. **Volume metrics carry no verdict.** Spend and impressions report a
   percentage with `better: null`. Marking a spend decrease "worse" with no
   reference to what it bought is a wrong verdict in front of a client.

Campaigns present in only one month are separated into started/stopped rather
than given a percentage against zero, and the movers lists rank by money at
stake, not by percentage — a 90% swing on $12 is noise.

**Uploads can now append.** `commitUpload({ mode: "append" })` merges a file into
an existing batch instead of replacing it: entity ids are deterministic per
batch, so a campaign in both files updates in place and only its new dates are
inserted. Batch statistics are recomputed from the database after every commit
so the recorded counts cannot drift from the rows, and `sources` records every
file that fed the batch. A capability is claimed only if EVERY source file
supports it — if August carried frequency and September did not, the batch
cannot offer frequency.

Tests: `npm run test:monthly` (20 checks, mostly about partial months and
verdicts).

## 3. Live data flow

```
System User token (env)
  → GET /act_<id>/campaigns                    campaign shells
  → GET /act_<id>/insights?level=campaign      daily campaign metrics
  → GET /{campaign_id}/adsets                  ad sets  (walked PER CAMPAIGN)
  → GET /{adset_id}/ads                        ads      (walked PER AD SET)
  → GET /act_<id>/insights?level=adset|ad      daily ad set / ad metrics
  → upsert into meta_* tables in Neon
  → UI reads ONLY from Neon, never from Meta directly
```

The hierarchy walk is deliberate: an earlier version fetched
`/act_<id>/adsets` account-wide and matched on the returned `campaign_id`,
which silently dropped ad sets. Parentage now comes from the edge queried.

**There is no OAuth.** Authentication is a long-lived System User token with
`ads_read`, stored in `META_ACCESS_TOKEN`. Multi-tenant OAuth would need Meta
App Review and is out of scope.

## 4. Environment variables

| Name | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon pooled connection string. Also all that uploads need — no Meta credentials required. |
| `META_ACCESS_TOKEN` | live only | System User token, `ads_read` |
| `META_AD_ACCOUNT_ID` | live only | digits only, no `act_` prefix |
| `META_CURRENCY` | live only | e.g. `INR` — without it money renders as `$` |
| `GROQ_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / … | optional | any one enables the LLM narrative; without one the deterministic analyst answers |
| `DATA_SOURCE` | optional | `merged` (default when Meta configured), `meta`, `mock` |
| `LLM_PROVIDER`, `LLM_MAX_TOKENS` | optional | force a provider / raise token budget |

Env vars only bind on deploy — **always redeploy after changing them.**

## 5. Current state — verified

- Demo Mode: all 8 pages render, seeded content and authored deltas unchanged
- Live sync: `{"synced":true,"campaigns":2,"dayRows":26,"adsets":2,"ads":4,"currency":"INR"}`
- Live campaign analysis renders with real values: spend ₹3,051, 252,256
  impressions, 2.93% CTR, ₹0.41 CPC, real date range, INR
- Provenance strip shows source, Meta campaign ID, objective, currency, range
- Revenue/ROAS correctly show **N/A** (the account reports no purchase value)

## 6. Current state — OPEN BUG

**The Adset Comparison tab shows "No ad sets stored for this campaign."**

Known facts:
- Ads Manager shows campaign `PC_Traffic_Jun26` HAS 1 ad set
  (`PC_Traffic_Parents_Hyd`) and 3 ads (`PC_TR_Carousel`, `PC_TR_Video1`,
  `PC_TR_Video2`)
- The sync reports `adsets: 2, ads: 4` stored account-wide
- The UI reports "1 ad set in the account belongs to other campaigns"
- So ad sets are being stored, but not against the campaign being viewed

Three candidate causes, in likelihood order:

1. **The sync has not been re-run since the hierarchical walk shipped.** The
   stored rows are from the older account-wide fetch. → re-run
   `/api/sync/meta?days=30`.
2. **A migration column is missing**, so the adset read query throws. The read
   path now surfaces this as `adsetError` in `/api/db/campaign-detail` and
   prints it in the tab. → run `ALL_IN_ONE_live.sql`.
3. **Orphaned rows** — `meta_adsets.campaign_id` doesn't match any
   `meta_campaigns.id`. → `99_diagnose.sql` block 3 proves this in one query.

**The single piece of evidence that resolves it:** the JSON from
`/api/sync/meta?days=30`. It now returns a `hierarchy` array giving ad set and
ad counts **per campaign**. That array answers the question directly. It has not
yet been captured after the hierarchical walk shipped.

## 7. Debugging order

1. Run `ALL_IN_ONE_live.sql` in Neon
2. Redeploy
3. `GET /api/sync/meta?days=30` — read the `hierarchy` array
4. `GET /api/db/status` — expect `db:true`, non-zero `metaCampaigns`
5. Open a live campaign → Adset tab → it now prints the real Postgres error if
   the read fails
6. `04_verify.sql` for row counts + hierarchy; `99_diagnose.sql` for everything

## 8. Design rules — do not violate

- **No fabricated numbers in Live Mode.** Every displayed figure must trace to a
  Graph API field or a stated calculation. Seeded literals (`↑12%`,
  `Snapshot · Today 02:00`, `25–44 Male`) are gated behind `!isLive`.
- **Unavailable ≠ zero.** Missing metrics render `N/A` with a reason. Days with
  no conversions are `null` in `cpaTrend` so charts show a gap, not a zero line.
- **Revenue comes from `conv_value`**, never `roas × spend`.
- **Results are objective-specific** — purchases for Sales, landing page views
  for Traffic, leads for Leads — matching Ads Manager's Results column. The KPI
  card is labelled with what it counted.
- **No silent fallbacks in Live Mode.** A failed live read returns an error, not
  an empty array. (This rule was added *because* a `.catch(() => [])` disguised a
  real failure as "no data" and cost hours.)
- **Never widen the LLM's authority.** It receives an evidence pack and writes
  prose; `verifyCitations` rejects any number not present in that pack.
- **Currency via `lib/currency.ts` only.** Never hardcode `$`.
- **Hooks before early returns.** A `useEffect` placed after the loading-state
  return caused a hook-count crash on live campaigns.

## 9. Known limitations (documented, not bugs)

- Share-of-target-audience is not derivable from the Insights API — no
  saturation percentage anywhere. Absolute peak-day reach is shown instead.
- `verifyCitations` matches values, not entities: a real number attributed to
  the wrong ad set would pass. Flagged at CP1; still open.
- Campaign pacing needs a budget; when budgets live at ad set level the sum is
  used, otherwise pacing shows "budget not reported".
- Cross-platform compare mode is untested with a live account selected.

## 10. Layout

```
lib/
  data.ts          seeded dataset + shared types (Campaign, AdSet, AdItem)
  datasource.ts    DataSource interface; Mock / Meta / Merged implementations
  meta.ts          Graph API fetchers + Neon readers/mappers  ← live logic
  meta-labels.ts   objective → result-type ladder (client-safe)
  reasoning.ts     evidence builder, deterministic analyst, citation verifier
  llm.ts           provider-agnostic narrative layer (7 providers)
  currency.ts      single money-formatting helper
app/api/sync/meta  the ONLY route that calls Meta
app/api/db/*       read routes: status, accounts, campaign-detail, adset-detail
```
