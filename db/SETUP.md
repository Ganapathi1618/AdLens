# AdLens — Neon Database Setup WITHOUT a Terminal

Everything happens in three browser tabs: Neon, GitHub, Vercel.
Total time: ~10 minutes. Do the steps in order.

---

## Step 1 — Create a Neon database (Neon tab)

1. Open **console.neon.tech** and create a project (the free tier is plenty)
2. That's it. **There is no schema to install.**

AdLens creates every table it needs on first use — the first sync or the first
upload runs `CREATE TABLE IF NOT EXISTS` for the whole `meta_*` set. You never
have to run a migration by hand.

> **Upgrading from the hackathon build?** Run `db/drop-seeded.sql` once in the
> SQL Editor to delete the old demo tables (`campaigns`, `adsets`, `ads`,
> `recommendations`, `alerts`). Nothing reads them any more. It does not touch
> your synced or uploaded data. Take a Neon branch first if you want the demo
> portfolio recoverable.

The SQL files in this folder are references for what the app writes, not steps
you must run: `meta-sync.sql` (synced data), `upload.sql` (uploaded reports),
`meta-oauth.sql` (Connect with Facebook).

## Step 2 — Push this project to GitHub (already wired)

Every code file is already in this project — `lib/db.ts`, the routes under
`app/api/db/...`, and the `@neondatabase/serverless` dependency in package.json.

Push this project to your GitHub repo. Vercel installs and builds it for you.

## Step 3 — Give Vercel the database address (Vercel tab)

1. In Neon → **Dashboard → Connection string** → select **Pooled connection** → copy it
2. In Vercel → your project → **Settings → Environment Variables**
3. Add: Name = `DATABASE_URL` · Value = the copied string · all environments
4. **Deployments** tab → ⋯ on the latest → **Redeploy**

Env vars only bind at build time, so the redeploy is required.

## Step 4 — Check it worked

Open in your browser:

```
https://YOUR-APP.vercel.app/api/db/status
```

`{"db":true, …}` means Vercel can reach Neon. `metaCampaigns` and `uploads` will
both be `0` until you bring data in — that is expected on a fresh database.

## Step 5 — Bring in data

The app is empty by design until you do one of these:

- **Upload a report** — go to `/upload` and drop in an Ads Manager `.csv` or
  `.xlsx` export. Needs no Meta credentials at all.
- **Connect an ad account** — go to `/check` → **Connect with Facebook**, pick
  the accounts to share, then **Sync now**. Needs `META_APP_ID`,
  `META_APP_SECRET` and `TOKEN_ENCRYPTION_KEY` set (see CONNECT-META.md).

Either one fills the same tables, and every page works off the result.

## What NOT to worry about

- **Prisma** — skipped on purpose; it needs terminal commands. The Neon
  driver does the same job with plain SQL.
- **Migrations** — tables are created on first use; for schema changes, edit
  them in Neon's SQL Editor.

## Troubleshooting

- `/api/db/status` shows `{"db":false}` → `DATABASE_URL` missing or wrong in
  Vercel → re-check Step 3, redeploy.
- `db:true` but counts stay `0` → nothing has been synced or uploaded yet;
  that is Step 5, not an error.
- Build fails on Vercel → check `package.json` is valid JSON (commas are picky).
