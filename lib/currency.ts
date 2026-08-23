// ── Single source of truth for money formatting ─────────────────────
// Previously three places did `currency === "INR" ? "₹" : "$"`, which
// silently rendered every non-INR account as dollars. Import this instead.
// Safe for client components: no DB or server-only imports.

const SYMBOLS: Record<string, string> = {
  USD: "$", INR: "\u20b9", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5",
  AUD: "A$", CAD: "C$", SGD: "S$", NZD: "NZ$", AED: "AED ", SAR: "SAR ",
  BRL: "R$", MXN: "MX$", ZAR: "R", CHF: "CHF ", SEK: "kr ", NOK: "kr ",
  DKK: "kr ", PLN: "z\u0142 ", TRY: "\u20ba", IDR: "Rp ", MYR: "RM ",
  PHP: "\u20b1", THB: "\u0e3f", VND: "\u20ab", KRW: "\u20a9", CNY: "CN\u00a5",
  HKD: "HK$", TWD: "NT$", ILS: "\u20aa", NGN: "\u20a6", KES: "KSh ",
};

/** Symbol for an ISO currency code. Unknown codes fall back to the code itself
 *  (e.g. "PKR 1,200") — never to "$", which would misstate the amount. */
export function sym(code: string | null | undefined): string {
  if (!code) return "$";
  return SYMBOLS[String(code).toUpperCase()] ?? `${String(code).toUpperCase()} `;
}

/** Format an amount in the account's currency. */
export function money(n: number, code: string | null | undefined): string {
  return `${sym(code)}${Math.round(n).toLocaleString()}`;
}

/** Compact form for dense UI — ₹1.2M, $4.2k. Keeps the account's symbol. */
export function moneyShort(n: number, code: string | null | undefined): string {
  const s = sym(code);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${s}${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${s}${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${s}${Math.round(n)}`;
}

export interface CurrencyBearing { currency?: string | null; id?: string }

/**
 * The single currency a set of campaigns shares, or null when they differ.
 *
 * Totals across currencies are meaningless — ₹100 + $100 is not 200 of
 * anything — so callers must use this to decide whether a combined figure can
 * be shown at all. Campaigns with no reported currency are treated as USD,
 * the default when an account reports none.
 */
export function commonCurrency(items: CurrencyBearing[]): string | null {
  const codes = new Set(items.map((c) => String(c.currency || "USD").toUpperCase()));
  return codes.size === 1 ? (Array.from(codes)[0] as string) : null;
}

/** Group amounts by currency so a mixed portfolio can be reported honestly
 *  ("₹82,140 + $9,020") instead of as one invented total. */
export function sumByCurrency<T extends CurrencyBearing>(
  items: T[],
  amount: (item: T) => number,
): { code: string; total: number }[] {
  const by = new Map<string, number>();
  for (const it of items) {
    const code = String(it.currency || "USD").toUpperCase();
    by.set(code, (by.get(code) ?? 0) + amount(it));
  }
  return Array.from(by.entries())
    .map(([code, total]) => ({ code, total }))
    .sort((a, b) => b.total - a.total);
}

/** Renders a mixed-currency total as separate amounts joined by "+". */
export function formatMixed(parts: { code: string; total: number }[]): string {
  return parts.map((p) => money(p.total, p.code)).join(" + ");
}
