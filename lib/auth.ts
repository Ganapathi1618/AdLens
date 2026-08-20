// ── Access control ──────────────────────────────────────────────────
// AdLens shows real ad accounts' spend and lets anyone with the URL upload and
// delete reports, so a public deployment is a data leak, not a demo. This is
// the gate: one shared password for the whole app.
//
// Deliberately small, and deliberately dependency-free:
//   * Runs in Edge middleware, so it uses Web Crypto only — no Node APIs, no
//     next-auth, no database round trip on every request.
//   * ONE env var. The signing key is derived from the password itself, so
//     changing APP_PASSWORD invalidates every existing session for free.
//
// This is a shared-secret gate for a single-tenant agency tool, not per-user
// identity. If AdLens ever needs per-user accounts, audit trails or roles, this
// should be replaced rather than extended.

export const SESSION_COOKIE = "adlens_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether a password has been configured for this deployment. */
export function authConfigured(): boolean {
  return Boolean((process.env.APP_PASSWORD ?? "").trim());
}

const enc = new TextEncoder();

/** Signing key. AUTH_SECRET overrides, otherwise the password is the secret. */
function secret(): string {
  const explicit = (process.env.AUTH_SECRET ?? "").trim();
  return explicit || `adlens:${(process.env.APP_PASSWORD ?? "").trim()}`;
}

function base64url(bytes: ArrayBuffer): string {
  let bin = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/**
 * Length-independent, content-constant-time comparison.
 *
 * Both sides are hashed first so the comparison length never depends on the
 * secret, which a plain loop over raw strings would leak.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([hmac(`cmp:${a}`), hmac(`cmp:${b}`)]);
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

/** Is this the configured password? */
export async function passwordMatches(candidate: string): Promise<boolean> {
  const expected = (process.env.APP_PASSWORD ?? "").trim();
  if (!expected) return false;
  return safeEqual(candidate, expected);
}

/** A signed session token that carries only its own expiry. */
export async function createSessionToken(now = Date.now()): Promise<string> {
  const exp = String(now + SESSION_TTL_MS);
  return `${exp}.${await hmac(exp)}`;
}

/** Valid signature and not expired. */
export async function verifySessionToken(token: string | undefined | null, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < now) return false;
  // Compare signatures directly — both are already HMAC output of fixed length.
  const expected = await hmac(exp);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/**
 * Paths that must stay reachable without a session.
 *
 * The Meta endpoints are called by Facebook's servers, not by a browser that
 * could ever hold a cookie — gating them would silently break data-deletion
 * and deauthorize callbacks, which Meta requires to keep working. The cron
 * endpoint is called by the platform scheduler and has its own SYNC_SECRET.
 */
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/meta/data-deletion",
  "/api/auth/meta/deauthorize",
  "/api/cron/sync",
  "/api/health",
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
