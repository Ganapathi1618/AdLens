// ── Minimal XLSX reader — no dependencies ───────────────────────────
// Ads Manager exports arrive as .xlsx far more often than .csv, so uploads
// have to read one. The two SheetJS distributions are an abandoned npm build
// and an off-registry tarball; neither belongs in a dependency list for what
// is actually needed here — read one sheet of a flat export into rows of
// strings.
//
// Scope, deliberately narrow. Anything outside it throws with a message the
// upload route shows the user, rather than returning silently wrong cells:
//   • ZIP entries: stored (method 0) and deflate (method 8). No ZIP64, no
//     encryption, no split archives.
//   • Cell types: shared string, inline string, formula string, boolean, error
//     and number.
//   • Dates: a numeric cell whose style resolves to a date format is returned
//     as an ISO date, because "45870" is not something a user can map.
//
// Every value comes back as a string. The coercion layer (lib/csv.ts) is the
// single place that decides what a string means, so .xlsx and .csv uploads
// cannot diverge in how a number or a date is read.

import { inflateRawSync } from "node:zlib";

/* ═══════════════════════ ZIP ═══════════════════════ */

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;

function findEndOfCentralDirectory(buf: Buffer): number {
  // The EOCD is last, but a trailing comment (max 64KB) can follow it.
  const floor = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Every entry in the archive, by name. Only the members we need are inflated. */
export function unzip(buf: Buffer, wanted?: (name: string) => boolean): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error("Not a valid .xlsx file (no ZIP end-of-central-directory record).");

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdirOffset = buf.readUInt32LE(eocd + 16);
  if (cdirOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported. Re-save the file as .xlsx or export as CSV.");
  }

  const out = new Map<string, Buffer>();
  let p = cdirOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDIR_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (wanted && !wanted(name)) continue;
    if (name.endsWith("/")) continue;

    // The local header repeats the name/extra with its OWN lengths — the
    // central directory's extra length is routinely different, and using it
    // here is the classic way to read a file offset by a few bytes.
    if (localOffset + 30 > buf.length) throw new Error(`Corrupt .xlsx: bad offset for "${name}".`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const end = start + compressedSize;
    if (end > buf.length) throw new Error(`Corrupt .xlsx: truncated entry "${name}".`);
    const raw = buf.subarray(start, end);

    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`Unsupported ZIP compression (method ${method}) in "${name}".`);
  }
  return out;
}

/* ═══════════════════════ XML ═══════════════════════ */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec, hex, named) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[named as string] ?? m;
  });
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

/** Concatenated <t> text of one element, ignoring phonetic <rPh> runs. */
function textOf(xml: string): string {
  const body = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, "");
  let out = "";
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out += decodeXml(m[1] ?? "");
  return out;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] === undefined ? "" : textOf(m[1]));
  return out;
}

/* ═══════════════════════ number formats ═══════════════════════ */

// Excel's built-in date/time format ids.
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47, 27, 30, 36, 50, 57]);

/** Does a format code render a date or time? Literals and colour/condition
 *  sections are stripped first so `"Total: "0.00` is not read as a date. */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(stripped);
}

/** Style index → true when that style renders a date. */
function parseDateStyles(stylesXml: string): Set<number> {
  const customDate = new Set<number>();
  const nfRe = /<numFmt\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = nfRe.exec(stylesXml))) {
    const id = Number(attr(m[1], "numFmtId"));
    const code = attr(m[1], "formatCode") ?? "";
    if (Number.isFinite(id) && isDateFormatCode(code)) customDate.add(id);
  }

  const dateStyles = new Set<number>();
  // Only cellXfs (not cellStyleXfs) maps a cell's s="N" to a format.
  const block = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!block) return dateStyles;
  const xfRe = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let i = 0;
  while ((m = xfRe.exec(block[1]))) {
    const id = Number(attr(m[1], "numFmtId") ?? "0");
    if (BUILTIN_DATE_IDS.has(id) || customDate.has(id)) dateStyles.add(i);
    i++;
  }
  return dateStyles;
}

/* ═══════════════════════ values ═══════════════════════ */

const MS_PER_DAY = 86_400_000;

/**
 * Excel serial → ISO date (or ISO datetime when the cell carries a time).
 *
 * The epoch is 1899-12-30, not 1900-01-01, because Excel deliberately keeps
 * Lotus 1-2-3's non-existent 29 Feb 1900. Serials below 61 predate that fake
 * day and need the other base, so both are handled rather than being off by
 * one for two months of 1900.
 */
export function serialToISO(serial: number): string {
  const base = serial < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const ms = base + Math.round(serial * MS_PER_DAY);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return String(serial);
  const iso = d.toISOString();
  // A whole-day serial is a date, not midnight — don't invent a time on it.
  return Math.abs(serial - Math.round(serial)) < 1e-9 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

function colIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/* ═══════════════════════ sheets ═══════════════════════ */

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

export interface ReadXlsxOptions {
  /** Hard ceiling on rows read per sheet — an upload must not be able to
   *  exhaust memory. Rows beyond it are dropped and `truncated` is set. */
  maxRows?: number;
}

export interface XlsxResult {
  sheets: XlsxSheet[];
  truncated: boolean;
}

function sheetTargets(zip: Map<string, Buffer>): { name: string; path: string }[] {
  const wb = zip.get("xl/workbook.xml");
  if (!wb) throw new Error("Not a valid .xlsx file (no workbook).");
  const wbXml = wb.toString("utf8");

  const rels = new Map<string, string>();
  const relsBuf = zip.get("xl/_rels/workbook.xml.rels");
  if (relsBuf) {
    const re = /<Relationship\b([^>]*)\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(relsBuf.toString("utf8")))) {
      const id = attr(m[1], "Id");
      let target = attr(m[1], "Target");
      if (!id || !target) continue;
      target = target.replace(/^\/xl\//, "").replace(/^\.\//, "");
      rels.set(id, target.startsWith("xl/") ? target : `xl/${target}`);
    }
  }

  const out: { name: string; path: string }[] = [];
  const re = /<sheet\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wbXml))) {
    const name = attr(m[1], "name") ?? `Sheet${out.length + 1}`;
    const rid = attr(m[1], "r:id") ?? attr(m[1], "id");
    const path = (rid && rels.get(rid)) || `xl/worksheets/sheet${out.length + 1}.xml`;
    out.push({ name, path });
  }
  return out;
}

function parseSheet(xml: string, shared: string[], dateStyles: Set<number>, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;

  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm: RegExpExecArray | null;

  while ((rm = rowRe.exec(xml))) {
    if (rows.length >= maxRows) { truncated = true; break; }
    const body = rm[2] ?? "";
    const cells: string[] = [];
    let cm: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(body))) {
      const tag = cm[1];
      const inner = cm[2] ?? "";
      const ref = attr(tag, "r");
      const type = attr(tag, "t") ?? "n";
      const style = Number(attr(tag, "s") ?? "-1");

      let value = "";
      if (type === "inlineStr") {
        value = textOf(inner);
      } else {
        const v = inner.match(/<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/);
        const raw = v ? decodeXml(v[1] ?? "") : "";
        if (type === "s") {
          const idx = Number(raw);
          value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : "";
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : "FALSE";
        } else if (type === "e") {
          value = ""; // #N/A, #DIV/0! — an error is absence, never a number
        } else if (type === "str") {
          value = raw;
        } else {
          const n = Number(raw);
          value = raw !== "" && Number.isFinite(n) && dateStyles.has(style) ? serialToISO(n) : raw;
        }
      }

      // Honour the cell reference so gaps stay aligned with the header row.
      const at = ref ? colIndex(ref) : cells.length;
      if (at < 0 || at > 16_383) continue;
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    // Placement by row index would need the r attribute; a blank row is kept
    // as [] so the caller's own blank-row skipping stays in one place.
    rows.push(cells);
  }
  return { rows, truncated };
}

/** Read every sheet of an .xlsx workbook into rows of strings. */
export function readXlsx(buf: Buffer, opts: ReadXlsxOptions = {}): XlsxResult {
  const maxRows = opts.maxRows ?? 250_000;
  const zip = unzip(buf, (n) =>
    n === "xl/workbook.xml" ||
    n === "xl/_rels/workbook.xml.rels" ||
    n === "xl/sharedStrings.xml" ||
    n === "xl/styles.xml" ||
    n.startsWith("xl/worksheets/"));

  const shared = zip.has("xl/sharedStrings.xml")
    ? parseSharedStrings(zip.get("xl/sharedStrings.xml")!.toString("utf8"))
    : [];
  const dateStyles = zip.has("xl/styles.xml")
    ? parseDateStyles(zip.get("xl/styles.xml")!.toString("utf8"))
    : new Set<number>();

  const sheets: XlsxSheet[] = [];
  let truncated = false;
  for (const { name, path } of sheetTargets(zip)) {
    const buf2 = zip.get(path);
    if (!buf2) continue;
    const parsed = parseSheet(buf2.toString("utf8"), shared, dateStyles, maxRows);
    truncated = truncated || parsed.truncated;
    sheets.push({ name, rows: parsed.rows });
  }
  if (!sheets.length) throw new Error("That .xlsx file has no readable sheets.");
  return { sheets, truncated };
}
