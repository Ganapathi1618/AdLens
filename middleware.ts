// ── The gate ────────────────────────────────────────────────────────
// Every page and every API route requires a session, except the handful in
// lib/auth.ts that Meta's and the platform's servers call directly.
//
// The important decision here is what to do when APP_PASSWORD is NOT set:
//
//   development → allow. Local work must not need a password.
//   production  → refuse everything with instructions.
//
// Failing open in production is what made a real client's spend readable by
// anyone with the URL, so it fails closed by construction. A deployment that
// forgets the variable is unusable rather than silently public.

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authConfigured, isPublicPath, verifySessionToken } from "@/lib/auth";

export const config = {
  // Everything except Next's own static output and static asset requests.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|otf|map)$).*)"],
};

const SETUP_HTML = `<!doctype html><meta charset="utf-8">
<title>AdLens — setup required</title>
<style>
  body{background:#0b0d14;color:#e8eaf2;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  main{max-width:560px}
  h1{font-size:20px;margin:0 0 12px}
  code{background:#171a27;padding:2px 6px;border-radius:6px;font-size:13px}
  p{color:#9aa1b8}
</style>
<main>
  <h1>AdLens needs a password before it can serve this deployment</h1>
  <p>This app shows real ad account data and accepts uploads, so it refuses to
     run unprotected in production.</p>
  <p>Set <code>APP_PASSWORD</code> in your hosting provider's environment
     variables and redeploy. That is the only variable access control needs.</p>
</main>`;

/**
 * Pass the path down to the root layout.
 *
 * A server layout cannot read the current route, and it needs to: the login
 * screen must not render the sidebar or the AI panel. Forwarding it as a
 * request header is the supported way to do that without turning the layout
 * into a client component.
 */
function withPathname(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return withPathname(req);

  const isApi = pathname.startsWith("/api/");

  if (!authConfigured()) {
    if (process.env.NODE_ENV !== "production") return withPathname(req);
    return isApi
      ? NextResponse.json(
          { error: "APP_PASSWORD is not set on this deployment, so it refuses to serve data." },
          { status: 503 })
      : new NextResponse(SETUP_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)) {
    return withPathname(req);
  }

  // An expired session on a background fetch must not redirect JSON to HTML.
  if (isApi) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  const next = `${pathname}${req.nextUrl.search}`;
  if (next && next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}
