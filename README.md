# AdLens — AI-Powered Ad Campaign Intelligence

Know **why** your campaign is underperforming — in one click, not 40 minutes of Ads Manager digging.

Next.js 14 · TypeScript · Tailwind · Framer Motion · Recharts · Zustand.

## Run it locally

**Prerequisites:** Node.js 18.17 or newer (`node -v` to check), and a Postgres
connection string in `DATABASE_URL` — Neon's free tier is enough.

```bash
# 1. clone, then from the project folder:
npm install          # ~1 min

# 2. point it at a database
echo 'DATABASE_URL=postgres://…' >> .env.local

# 3. start the dev server
npm run dev          # → http://localhost:3000
```

AdLens shows only data you bring it — there is no sample dataset. On first run
every page is empty until you either **connect an ad account** (`/check`) and
sync it, or **upload an Ads Manager export** (`/upload`). Uploading needs no
Meta credentials at all and is the fastest way to see the whole app working.

Tables are created on first use; there is no migration step.

Other commands:

```bash
npm run build && npm start   # production build, → http://localhost:3000
npm test                     # unit tests (date ranges, intent, citations)
npx tsx tests/periods.test.mts         # WoW / MoM comparison
npx tsx tests/pacing-status.test.mts   # pacing + status
npx tsx tests/ai-pipeline.test.mts     # AI retrieval ordering, no canned answers
npx tsx tests/oauth.test.mts           # OAuth token-encryption + CSRF
```

Port already in use? `npm run dev -- -p 3001`.

### Where to click first

| Page | Path |
| --- | --- |
| Today's brief | `/` |
| Campaign portfolio | `/overview` |
| Account wizard (+ Connect with Facebook) | `/check` |
| Upload a report | `/upload` |
| Month-over-month report | `/monthly` |

### Optional: real Claude-powered AI chat

Create a `.env.local` file in the project root:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Restart `npm run dev`. The Ask AI panel then streams real Claude analysis
grounded in the selected campaign's metrics JSON. Without it, a deterministic
rule-based responder answers from the same data — so the demo never breaks.

### Optional: live Meta data + self-service account connection

Also in `.env.local` (all optional — the app runs fine without them):

```bash
DATABASE_URL=postgres://...        # Neon; enables live sync + persistence
META_APP_ID=...                    # enables "Connect with Facebook" on /check
META_APP_SECRET=...
TOKEN_ENCRYPTION_KEY=...           # openssl rand -hex 32
```

For local OAuth testing, add `http://localhost:3000/api/auth/meta/callback` to
your Meta app's **Valid OAuth Redirect URIs**. Database tables are created
automatically on first use — no migration step. Full setup: [CONNECT-META.md](CONNECT-META.md).

> Without `DATABASE_URL` everything still works, but connected accounts live
> in memory and reset when the server restarts.

## Uploaded reports

You do not need Meta account access to use AdLens. Go to **`/upload`**, drop in an
Ads Manager export (`.csv`, `.tsv` or `.xlsx`), and every screen works on it —
KPIs, trends, ad set drill-down, pacing, week-over-week and the AI analysis.

Only `DATABASE_URL` is required. No token, no OAuth, no app review.

**The preview is the point.** Before anything is saved, the upload screen names
what your file supports and, for everything it does not, why:

| Tier | What you get |
|---|---|
| **Full analysis** | Ad-level rows with a daily breakdown and a fatigue signal — everything, including creative fatigue detection |
| **Trends only** | Daily rows without ad-level detail — KPIs, trends, pacing, period comparison, but no creative diagnosis |
| **Snapshot only** | One row per entity, no daily breakdown — KPI totals and nothing else |

For the deepest analysis export **by Day** at the **Ad** level with Amount spent,
Impressions, Link clicks, Frequency, Results and Conversion value.

Two rules the importer never breaks:

- **A missing column is never a zero.** A file without impressions has no CTR —
  it does not have a CTR of 0%. Absent metrics are reported as unavailable
  everywhere, including to the model.
- **Uploaded data is never presented as live.** It is labelled with its filename
  and date range on every screen, and the AI is told it is a frozen extract.

Ratios are recomputed from period totals, lifetime budgets are pro-rated across
their flight so a one-month export paces against its own share of the budget,
and re-uploading a corrected export replaces the batch instead of doubling it.
Schema and storage details: [`db/upload.sql`](db/upload.sql).

### Building a month-over-month report from uploads

One report can hold several monthly exports. On `/upload`, pick **Add to an
existing report** instead of creating a new one — the file is merged by date, so
days it already covers are corrected and new months are added.

With two or more months in a report, **`/monthly`** compares any two of them:
portfolio metrics, the campaigns that improved or declined most, and the ones
that started or stopped between the months.

The partial month is handled explicitly. An export covering 1–18 August against
a full July would show spend "down 42%" — a fact about the export, not the
campaigns — so unequal months are cut to the same day span and the report says
it did that. Two complete months always compare in full, even when one has 30
days and the other 31, because that is what a calendar comparison means.

Spend and impressions are reported with a percentage but **no good/bad verdict**:
volume is not quality, and telling a client that spending less is "worse" is a
wrong answer, not a nuance.

## What's inside

| Page | What it does |
|---|---|
| **Home** | Today's Brief — Needs action / Watch / Opportunity cards + money-on-the-table strip |
| **Campaign overview** | Portfolio KPI strip (animated counters), your campaigns with sparklines, health dots, pacing bars, animated sort/filter/search |
| **Account check** | Platform → account → campaign wizard; 1 platform = deep dive, 2+ = cross-platform |
| **Analysis** | KPI strip, pacing gauge, anomaly chips, timeline presets (Daily/Weekly/Monthly/Overall/Custom), compare-periods A/B panel, 4 tabs |
| **Adset drill-down** | Per-adset KPIs, CTR/CPA trends, ad cards with Scale/Pause/Monitor, AI insight |
| **Cross-platform** | Meta vs LinkedIn, 3 plain metrics, visual bars, budget slider simulator |
| **Reporting** | 3-step selection → report view with charts, comparison table, AI narrative, PDF export |
| **Ledger** | Every recommendation → followed/ignored → measured outcome. 64% action rate, +31% avg improvement |
| **Alerts** | Rules-engine alerts (ROAS/CTR/CPC/pacing thresholds) |
| **Upload report** | No account access? Upload an Ads Manager export (.csv/.xlsx) and get the same analysis — see [Uploaded reports](#uploaded-reports) |
| **Month over month** | Two calendar months side by side across every campaign: portfolio deltas, biggest movers, campaigns that started or stopped. Printable |
| **Connect with Facebook** | Users add their own Meta ad accounts with one click — OAuth, no app setup or pasted tokens, unlimited accounts per deployment — see [CONNECT-META.md](CONNECT-META.md) |

## Architecture

- `lib/types.ts` — the shared domain types (`Campaign`, `AdSet`, `AdItem`). No values live here; every page reads through `lib/datasource.ts`.
- `lib/aiPipeline.ts` — the AI query pipeline: parse → resolve → fetch live Meta data → build context → analyze → generate. The model is only called on data that was actually retrieved.
- `app/api/ai/chat` — runs that pipeline. If retrieval fails or no model is configured it returns an explicit error; there is no templated answer path.
- `lib/pacing.ts` — time-aware pacing (spend vs budget × elapsed time) for campaigns and ad sets.
- `lib/status.ts` — Meta `effective_status` → Active / Paused / Archived / In Review.
- `lib/periods.ts` — week-over-week and month-over-month. Ratios are recomputed from period totals (never averaged across days), and a comparison is withheld when either window lacks history.
- `lib/adsReport.ts` — uploaded export → the app's own shapes: column mapping, capability tiering, and normalisation. `lib/xlsx.ts` is a dependency-free .xlsx reader; `lib/csv.ts` is the single place a cell becomes a number or a date, so .csv and .xlsx can never disagree.
- `lib/uploads.ts` — an uploaded report is stored as a synthetic ad account in the same `meta_*` tables, so it reuses the entire live read path rather than duplicating it. Commits are `replace` or `append`; appending is what lets one report accumulate several months.
- `lib/monthly.ts` — calendar-month comparison. `lib/periods.ts` does rolling 28-day windows for trend detection; this does "August vs July" for a client, which is a different question and needs different handling of partial months.
- `app/api/cron/sync` — nightly 02:00 UTC sync of **every** account, OAuth-connected and env-credential alike (schedule in `vercel.json`).
- `lib/store.ts` — Zustand: selected campaign drives AI panel visibility (only shows after a campaign is chosen).


