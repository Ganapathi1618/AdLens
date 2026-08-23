# AdLens — Live Meta Data (already wired into this repo)

Every code file is ALREADY in this project. Add two values to Vercel and the app
syncs your own ad account. Without them, `/upload` is the other supported way in —
see CONNECT-META.md for the self-service OAuth route.

What's in the repo now:

| File | What it does |
|---|---|
| `lib/meta.ts` | NEW — Graph API fetchers + mappers into the app's own Campaign/DayPoint types |
| `lib/datasource.ts` | `LiveDataSource` — the single implementation, reading the `meta_*` tables |
| `app/api/sync/meta/route.ts` | NEW — pulls Meta campaigns + daily insights into Neon |
| `app/api/db/status/route.ts` | NEW — campaign count · upload count · last-synced (header-badge data) |
| `db/meta-sync.sql` | NEW — three additive tables: `meta_campaigns`, `meta_daily_metrics`, `sync_log` |

The safety rules baked in:

- No token set → sync route is a polite no-op, UI unchanged, build passes.
- Token set but Meta errors → the error is surfaced, and the last good synced rows still render.
- A failed sync never deletes anything — upserts only.
- Every page reads through `dataSource`; nothing is displayed that Postgres did not supply.

---

## Step 1 — Meta's side (only YOU can do this, ~30–45 min)

You're creating an app (the "key ring") and a token (the "key") that can READ your own
ad account. No app review needed — Development mode is enough for your own assets.

1. **Create the app** — developers.facebook.com → My Apps → **Create App** → type
   **Business** → name it `adlens-sync`.
2. **Add the Marketing API** — app dashboard → Add Product → **Marketing API** → Set up.
   (Stays in Development mode — fine for your own account.)
3. **Create a System User** (token that doesn't expire hourly) — business.facebook.com →
   **Settings** → Users → **System Users** → Add → name `adlens-sync`, role **Employee**.
4. **Assign your ad account** — on the System User page → **Add Assets** → Ad Accounts →
   pick yours → enable **View performance** → Save.
5. **Generate the token** (shown ONCE — save it) — System User page → **Generate New
   Token** → select the `adlens-sync` app → tick **`ads_read`** and **`read_insights`** →
   Generate → copy.
6. **Ad Account ID** — Ads Manager URL contains `act=1234567890123`. Copy **only the
   number** (no `act_` — the code adds it).

> Quick smoke test alternative: Graph API Explorer can mint a short-lived token
> (~1–2 h). Fine for a first try, useless beyond that. The System User token is the keeper.

## Step 2 — Create the tables (Neon, 2 min)

console.neon.tech → your project → **SQL Editor** → paste ALL of `db/meta-sync.sql` →
**Run** → expect `meta tables ready`.

## Step 3 — Flip the switch (Vercel, 3 min)

Settings → Environment Variables:

| Name | Value | Required? |
|---|---|---|
| `META_ACCESS_TOKEN` | System User token | yes |
| `META_AD_ACCOUNT_ID` | number only, e.g. `1234567890123` | yes |
| `SYNC_SECRET` | any random string | optional — locks the sync URL |
| `META_API_VERSION` | e.g. `v23.0` | optional override |

Then **Deployments → Redeploy** (env vars only apply to new deployments).

## Step 4 — Verify (2 min, all in the browser)

1. `/api/db/status` → expect `"liveConfigured": true`
2. `/api/sync/meta?days=7` → expect `"synced": true` with counts
   (add `&key=YOUR_SYNC_SECRET` if you set one)
3. `/api/db/accounts` → your real campaigns, with ids like `"meta_1234…"` and
   `"note": "Live · Meta Graph API"`
4. `/api/db/status` again → `lastSynced` is stamped. That's the badge data.

If step 2 errors, it prints **Meta's actual error message** — 90% of the time it's a
token missing `ads_read`, or an account id typed with the `act_` prefix.

## The data source (`lib/datasource.ts`)

`LiveDataSource` is the only implementation. It reads the `meta_*` tables, which
hold both synced rows (`data_source = 'graph'`) and uploaded ones
(`data_source = 'upload'`). There is no mode switch and no seeded fallback — a
database with nothing in it produces empty states, never invented campaigns.
