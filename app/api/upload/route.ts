// ── Upload a report ─────────────────────────────────────────────────
// Two-phase on purpose. `preview` parses the file and answers "here is what I
// think your columns are, and here is exactly what this file can and cannot
// support" WITHOUT writing anything. `commit` re-parses with whatever mapping
// the user confirmed and writes it.
//
// Re-parsing on commit rather than caching the preview keeps the server
// stateless between the two calls, and means the committed numbers always
// come from the bytes the user actually sent.

import { NextResponse } from "next/server";
import {
  readReport, analyzeReport, normalizeReport,
  type Mapping, type Field,
} from "@/lib/adsReport";
import {
  commitUpload, listBatches, deleteBatch, getBatch,
  newUploadAccountId, isUploadAccount, ensureUploadSchema,
} from "@/lib/uploads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const NO_STORE = { headers: { "Cache-Control": "no-store, max-age=0" } };

/** Hosted serverless platforms cap request bodies well below this (Vercel at
 *  4.5MB); the ceiling here is for self-hosted runs, and the UI says so. */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 250_000;

function badRequest(error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status: 400, ...NO_STORE });
}

/** Mapping arrives as JSON from the browser; accept only known fields and
 *  integer column indexes so a crafted body cannot reach the parser. */
function parseMapping(raw: string | null): Mapping | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const out: Mapping = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const n = Number(v);
    if (!Number.isInteger(n)) continue;
    out[k as Field] = n;
  }
  return out;
}

export async function GET() {
  try {
    return NextResponse.json({ ok: true, batches: await listBatches() }, NO_STORE);
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "could not list uploads", batches: [] },
      { status: 500, ...NO_STORE });
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "commit" ? "commit" : "preview";

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest("Could not read the upload. On hosted deployments the request body is capped at about 4.5MB — split the export by date range, or export as CSV.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) return badRequest("No file was attached.");
  if (file.size === 0) return badRequest("That file is empty.");
  if (file.size > MAX_BYTES) {
    return badRequest(`That file is ${(file.size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_BYTES / 1024 / 1024}MB limit. Split it by date range and upload each part.`);
  }

  const filename = file.name || "upload.csv";
  if (!/\.(csv|tsv|txt|xlsx|xlsm|xls)$/i.test(filename)) {
    return badRequest("Unsupported file type. Upload a .csv, .tsv or .xlsx export.");
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const sheet = (form.get("sheet") as string | null) || undefined;
  const mappingOverride = parseMapping(form.get("mapping") as string | null);

  let read, analysis;
  try {
    read = readReport(buf, filename, sheet, MAX_ROWS);
    analysis = analyzeReport(read, mappingOverride);
  } catch (e: unknown) {
    return badRequest(e instanceof Error ? e.message : "Could not read that file.");
  }

  if (mode === "preview") {
    return NextResponse.json({ ok: analysis.errors.length === 0, filename, analysis }, NO_STORE);
  }

  // ── commit ──
  if (analysis.errors.length) {
    return badRequest(analysis.errors[0], { analysis });
  }

  // Re-committing an existing batch keeps its id, so links already handed out
  // (and the campaign ids derived from it) stay valid.
  //
  // mode=append merges this file into that batch instead of replacing it,
  // which is how one report accumulates several months for a month-over-month
  // comparison. Appending to nothing is just a normal first upload.
  const commitMode = (form.get("commitMode") as string | null) === "append" ? "append" : "replace";
  const requested = (form.get("account") as string | null) ?? "";
  const account = isUploadAccount(requested) ? requested : newUploadAccountId();
  if (requested && !isUploadAccount(requested)) {
    return badRequest("That is not a valid uploaded-report id.");
  }
  if (requested && !(await getBatch(requested))) {
    return badRequest("That uploaded report no longer exists.");
  }

  const label = String(form.get("label") ?? "").trim()
    || filename.replace(/\.(csv|tsv|txt|xlsx|xlsm|xls)$/i, "").slice(0, 80)
    || "Uploaded report";
  const timezone = String(form.get("timezone") ?? "").trim() || "UTC";

  try {
    await ensureUploadSchema();
    const data = normalizeReport(read, analysis, account);
    if (!data.campaigns.length) {
      return badRequest("No campaigns could be read from that file. Check the campaign-name column mapping.");
    }
    const batch = await commitUpload({
      account, mode: requested ? commitMode : "replace",
      label, filename, sheet: analysis.sheet, timezone,
      level: analysis.level, granularity: analysis.granularity, tier: analysis.tier,
      distinctDays: analysis.distinctDays, rowsParsed: analysis.counts.rows,
      capabilities: analysis.capabilities, warnings: analysis.warnings,
      mapping: analysis.mapping, unmapped: analysis.unmapped,
      data,
    });
    return NextResponse.json({ ok: true, batch, analysis }, NO_STORE);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Could not save that upload.";
    return NextResponse.json(
      {
        ok: false,
        error: /DATABASE_URL/.test(message)
          ? "Uploads need a database. Set DATABASE_URL to a Neon connection string and try again."
          : message,
      },
      { status: 500, ...NO_STORE });
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!isUploadAccount(id)) return badRequest("Not a valid uploaded-report id.");
  try {
    const removed = await deleteBatch(id);
    if (!removed) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, ...NO_STORE });
    return NextResponse.json({ ok: true }, NO_STORE);
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "could not delete that upload" },
      { status: 500, ...NO_STORE });
  }
}
