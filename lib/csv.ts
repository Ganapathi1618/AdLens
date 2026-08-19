// ── Delimited text + value coercion ─────────────────────────────────
// Two jobs, kept together because they are the same decision made twice:
// turning bytes into a grid, and turning a cell into a number or a date.
//
// Both .csv and .xlsx uploads land here for coercion (lib/xlsx.ts returns
// strings for exactly that reason), so the two formats can never disagree
// about what "1,234.56" or "01/02/2026" means.

/* ═══════════════════════ delimited text ═══════════════════════ */

const DELIMITERS = [",", "\t", ";", "|"] as const;

/**
 * Which delimiter this file uses, decided on the header line only.
 *
 * Counting over the whole file would let commas inside a quoted campaign name
 * ("Summer Sale, Broad") outvote the real delimiter. Quoted spans are skipped
 * for the same reason.
 */
export function sniffDelimiter(text: string): string {
  const line = text.slice(0, 64_000).split(/\r?\n/)[0] ?? "";
  let best = ",";
  let bestCount = -1;
  for (const d of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { quoted = !quoted; continue; }
      if (!quoted && ch === d) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/** RFC 4180 parse: quoted fields, escaped quotes, embedded newlines, CRLF. */
export function parseDelimited(text: string, delimiter?: string, maxRows = 250_000): { rows: string[][]; truncated: boolean } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const d = delimiter ?? sniffDelimiter(src);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => {
    row.push(field); field = "";
    rows.push(row); row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") { quoted = true; continue; }
    if (ch === '"') { quoted = true; continue; } // stray quote mid-field
    if (ch === d) { endField(); continue; }
    if (ch === "\r") { if (src[i + 1] === "\n") i++; endRow(); if (rows.length >= maxRows) { truncated = true; break; } continue; }
    if (ch === "\n") { endRow(); if (rows.length >= maxRows) { truncated = true; break; } continue; }
    field += ch;
  }
  if (!truncated && (field !== "" || row.length)) endRow();

  // A trailing newline produces one empty row; drop it rather than letting it
  // look like a data row with every column blank.
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return { rows, truncated };
}

/* ═══════════════════════ numbers ═══════════════════════ */

export type NumberFormat = "us" | "eu";

const US_LIKE = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const EU_LIKE = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/;
const EU_DECIMAL = /^-?\d+,\d+$/;

/**
 * Whether a column writes "1.234,56" (eu) or "1,234.56" (us).
 *
 * Decided per column across every sample, because a single value like "1,234"
 * is genuinely ambiguous — it is one thousand two hundred in one locale and
 * 1.234 in the other. Only unambiguous shapes vote; ties go to "us", which is
 * what Ads Manager exports in by default.
 */
export function detectNumberFormat(samples: string[]): NumberFormat {
  let us = 0;
  let eu = 0;
  for (const raw of samples) {
    const s = stripCurrency(raw);
    if (!s) continue;
    if (US_LIKE.test(s)) us++;
    else if (EU_LIKE.test(s)) eu++;
    else if (EU_DECIMAL.test(s)) eu++;
    else if (/^-?\d+\.\d+$/.test(s)) us++;
  }
  return eu > us ? "eu" : "us";
}

/** Strip currency symbols, spaces (incl. NBSP/thin space) and trailing %. */
function stripCurrency(raw: string): string {
  return String(raw)
    .replace(/[\s   ]/g, "")
    .replace(/[^\d.,\-+eE%]/g, "")
    .replace(/%$/, "")
    .trim();
}

const BLANK = new Set(["", "-", "—", "–", "n/a", "na", "null", "none", "undefined", "#n/a", "not available"]);

/**
 * A cell as a number, or null when the cell holds no number.
 *
 * null and 0 are different answers and the distinction is load-bearing: an
 * empty "Purchases" cell means the day had no purchase data, while 0 means it
 * had none. Ads Manager writes both, and collapsing them would turn "not
 * reported" into "zero" everywhere downstream.
 */
export function parseNumber(raw: unknown, format: NumberFormat = "us"): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const text = String(raw).trim();
  if (BLANK.has(text.toLowerCase())) return null;

  let s = stripCurrency(text);
  if (!s || s === "-" || s === "+") return null;
  // A cell that is mostly letters ("Using ad set budget") is not a number.
  if (!/\d/.test(s)) return null;

  if (format === "eu") s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // Parenthesised negatives: (1,234) → -1234
  return /^\(.*\)$/.test(text.replace(/[\s ]/g, "")) ? -Math.abs(n) : n;
}

/* ═══════════════════════ dates ═══════════════════════ */

export type DateFormat = "iso" | "dmy" | "mdy" | "text";

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const SLASH = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const TEXT_DATE = /^(\d{1,2})?\s*([a-z]{3,9})\.?\s*(\d{1,2})?,?\s*(\d{4})$/i;

/**
 * Which layout a date column uses.
 *
 * "01/02/2026" is 1 February in most of the world and 2 January in the US, and
 * guessing wrong silently shifts a month of data. So the whole column votes: a
 * first component above 12 proves day-first, a second component above 12
 * proves month-first. Only when nothing in the column disambiguates does this
 * fall back to day-first, and the caller warns about it.
 */
export function detectDateFormat(samples: string[]): { format: DateFormat; ambiguous: boolean } {
  let iso = 0, text = 0, slash = 0, dmyProof = 0, mdyProof = 0;
  for (const raw of samples) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    if (ISO.test(s)) { iso++; continue; }
    if (TEXT_DATE.test(s)) { text++; continue; }
    const m = s.match(SLASH);
    if (!m) continue;
    slash++;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12) dmyProof++;
    else if (b > 12) mdyProof++;
  }
  if (iso >= text && iso >= slash) return { format: "iso", ambiguous: false };
  if (text >= slash) return { format: "text", ambiguous: false };
  if (dmyProof && !mdyProof) return { format: "dmy", ambiguous: false };
  if (mdyProof && !dmyProof) return { format: "mdy", ambiguous: false };
  // Either nothing proved it, or the column contains both — which is a broken
  // column, not a format. Say so instead of picking silently.
  return { format: "dmy", ambiguous: true };
}

const pad = (n: number) => String(n).padStart(2, "0");

function build(y: number, m: number, d: number): string | null {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const year = y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y;
  // Reject 31 April and friends rather than letting Date roll them forward.
  const probe = new Date(Date.UTC(year, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${year}-${pad(m)}-${pad(d)}`;
}

/** A cell as an ISO `YYYY-MM-DD` date, or null when it holds no date. */
export function parseDate(raw: unknown, format: DateFormat = "iso"): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || BLANK.has(s.toLowerCase())) return null;

  const isoM = s.match(ISO);
  if (isoM) return build(Number(isoM[1]), Number(isoM[2]), Number(isoM[3]));

  const textM = s.match(TEXT_DATE);
  if (textM) {
    const mon = MONTHS[textM[2].slice(0, 3).toLowerCase()];
    const day = Number(textM[1] ?? textM[3]);
    if (mon && Number.isFinite(day)) return build(Number(textM[4]), mon, day);
    return null;
  }

  const m = s.match(SLASH);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    // A component above 12 settles it regardless of the column's verdict —
    // one stray row must not be parsed into a different month than it says.
    if (a > 12) return build(y, b, a);
    if (b > 12) return build(y, a, b);
    return format === "mdy" ? build(y, a, b) : build(y, b, a);
  }
  return null;
}

/** Longest run of consecutive calendar days present in a sorted date list. */
export function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
