# AdLens — AI-Powered Ad Campaign Intelligence

Know **why** your campaign is underperforming — in one click, not 40 minutes of Ads Manager digging.

Built for HackAdTech – AI. Next.js 14 · TypeScript · Tailwind · Framer Motion · Recharts · Zustand.

## Run it locally

**Prerequisite:** Node.js 18.17 or newer (`node -v` to check). Nothing else — no
database, no Docker, no API keys.

```bash
# 1. unzip / clone, then from the project folder:
npm install          # ~1 min

# 2. start the dev server
npm run dev          # → http://localhost:3000
```

Open **http://localhost:3000** and you're in. The app runs on a deterministic
seeded dataset (55 campaigns, 230+ ad sets, 90 days of metrics with embedded
fatigue / saturation / ROAS-crash patterns), so every screen has realistic data
on first load.

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

### Required before deploying: a workspace password

AdLens shows real ad account data and accepts uploads, so a public URL is a
data leak rather than a demo. Set one variable:

```bash
APP_PASSWORD=something-long-and-random
```

Everything is gated behind it — every page and every API route — except the
login endpoints, Meta's own data-deletion/deauthorize callbacks and the cron
endpoint (which has its own `SYNC_SECRET`).

Locally, `npm run dev` without `APP_PASSWORD` stays open so development needs
no password. **In production a deployment with no `APP_PASSWORD` refuses to
serve anything** and says so, rather than silently exposing the data. Changing
the password signs everyone out.

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
| **Campaign overview** | Portfolio KPI strip (animated counters), 55 campaigns with sparklines, health dots, pacing bars, animated sort/filter/search |
| **Account check** | Platform → account → campaign wizard; 1 platform = deep dive, 2+ = cross-platform |
| **Analysis** | KPI strip, pacing gauge, anomaly chips, timeline presets (Daily/Weekly/Monthly/Overall/Custom), compare-periods A/B panel, 4 tabs |
| **Adset drill-down** | Per-adset KPIs, CTR/CPA trends, ad cards with Scale/Pause/Monitor, AI insight |
| **Cross-platform** | Meta vs LinkedIn, 3 plain metrics, visual bars, budget slider simulator |
| **Reporting** | 3-step selection → report view with charts, comparison table, AI narrative, PDF export |
| **Ledger** | Every recommendation → followed/ignored → measured outcome. 64% action rate, +31% avg improvement |
| **Alerts** | Threshold rules evaluated against your stored daily metrics — break-even ROAS, CTR decline, rising cost per result, pacing, saturation, stalled delivery |
| **Upload report** | No account access? Upload an Ads Manager export (.csv/.xlsx) and get the same analysis — see [Uploaded reports](#uploaded-reports) |
| **Month over month** | Two calendar months side by side across every campaign: portfolio deltas, biggest movers, campaigns that started or stopped. Printable |
| **Connect with Facebook** | Users add their own Meta ad accounts with one click — OAuth, no app setup or pasted tokens, unlimited accounts per deployment — see [CONNECT-META.md](CONNECT-META.md) |

## Architecture

- `lib/data.ts` — seeded deterministic dataset (the MockAdapter). Swap for Prisma + Meta Graph API in Phase 1; every page reads through this layer.
- `lib/aiPipeline.ts` — the AI query pipeline: parse → resolve → fetch live Meta data → build context → analyze → generate. The model is only called on data that was actually retrieved.
- `app/api/ai/chat` — runs that pipeline. If retrieval fails or no model is configured it returns an explicit error; there is no templated answer path.
- `lib/auth.ts` + `middleware.ts` — the access gate. Web Crypto only so it runs in Edge middleware; the signing key is derived from the password, so changing it invalidates every session.
- `lib/alerts.ts` — threshold rules over stored daily metrics. A rule whose metric the data does not contain is skipped, never reported as passing.
- `lib/dataMode.ts` — whether this deployment holds real data, resolved server-side. Invented demo figures are suppressed everywhere real numbers appear.
- `lib/pacing.ts` — time-aware pacing (spend vs budget × elapsed time) for campaigns and ad sets.
- `lib/status.ts` — Meta `effective_status` → Active / Paused / Archived / In Review.
- `lib/periods.ts` — week-over-week and month-over-month. Ratios are recomputed from period totals (never averaged across days), and a comparison is withheld when either window lacks history.
- `lib/adsReport.ts` — uploaded export → the app's own shapes: column mapping, capability tiering, and normalisation. `lib/xlsx.ts` is a dependency-free .xlsx reader; `lib/csv.ts` is the single place a cell becomes a number or a date, so .csv and .xlsx can never disagree.
- `lib/uploads.ts` — an uploaded report is stored as a synthetic ad account in the same `meta_*` tables, so it reuses the entire live read path rather than duplicating it. Commits are `replace` or `append`; appending is what lets one report accumulate several months.
- `lib/monthly.ts` — calendar-month comparison. `lib/periods.ts` does rolling 28-day windows for trend detection; this does "August vs July" for a client, which is a different question and needs different handling of partial months.
- `app/api/cron/sync` — nightly 02:00 UTC sync of **every** account, OAuth-connected and env-credential alike (schedule in `vercel.json`).
- `lib/store.ts` — Zustand: selected campaign drives AI panel visibility (only shows after a campaign is chosen).


