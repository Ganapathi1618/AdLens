// Sign out: clear the session cookie. Public by necessity (lib/auth.ts).

import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: SESSION_COOKIE, value: "", httpOnly: true, sameSite: "lax",
    secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0,
  });
  return res;
}
