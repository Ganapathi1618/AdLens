// Sign in with the shared password. Public by necessity (lib/auth.ts).

import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_MS, authConfigured, createSessionToken, passwordMatches } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Crude per-instance throttle: enough to make guessing impractical without
 *  adding a store. Serverless spreads requests across instances, so it is a
 *  speed bump, not a guarantee — the password itself must be strong. */
const attempts = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count++;
  return rec.count > MAX_ATTEMPTS;
}

export async function POST(req: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      { ok: false, error: "No password is configured for this deployment." },
      { status: 503 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (tooManyAttempts(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Wait a minute and try again." },
      { status: 429 });
  }

  let password = "";
  try {
    const body = await req.json();
    password = String(body?.password ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request." }, { status: 400 });
  }

  if (!(await passwordMatches(password))) {
    return NextResponse.json({ ok: false, error: "That password is not right." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: await createSessionToken(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
