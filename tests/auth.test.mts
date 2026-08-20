// ── Access control ──────────────────────────────────────────────────
// The gate that stops a public URL exposing a client's ad spend. Everything
// here is pure (Web Crypto only), so it runs without a server or a database.
//
//   npx tsx tests/auth.test.mts

import assert from "node:assert/strict";

let pass = 0;
const check = async (label: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    console.log(`  FAIL  ${label}\n        ${(e as Error).message}`);
    process.exitCode = 1;
  }
};

process.env.APP_PASSWORD = "correct horse battery staple";
delete process.env.AUTH_SECRET;

const auth = await import("../lib/auth.js");

console.log("\nConfiguration");
await check("a password makes auth configured", () => {
  assert.equal(auth.authConfigured(), true);
});
await check("blank or whitespace-only is not configured", () => {
  const saved = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = "   ";
  assert.equal(auth.authConfigured(), false);
  process.env.APP_PASSWORD = "";
  assert.equal(auth.authConfigured(), false);
  process.env.APP_PASSWORD = saved;
});

console.log("\nPassword");
await check("the right password is accepted", async () => {
  assert.equal(await auth.passwordMatches("correct horse battery staple"), true);
});
await check("a wrong password is rejected", async () => {
  assert.equal(await auth.passwordMatches("wrong"), false);
});
await check("a prefix of the password is rejected", async () => {
  assert.equal(await auth.passwordMatches("correct horse battery stapl"), false);
});
await check("empty input is rejected", async () => {
  assert.equal(await auth.passwordMatches(""), false);
});
await check("nothing matches when no password is set", async () => {
  const saved = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = "";
  assert.equal(await auth.passwordMatches(""), false);
  assert.equal(await auth.passwordMatches("anything"), false);
  process.env.APP_PASSWORD = saved;
});

console.log("\nSession tokens");
await check("a freshly issued token verifies", async () => {
  assert.equal(await auth.verifySessionToken(await auth.createSessionToken()), true);
});
await check("a missing token is rejected", async () => {
  assert.equal(await auth.verifySessionToken(undefined), false);
  assert.equal(await auth.verifySessionToken(null), false);
  assert.equal(await auth.verifySessionToken(""), false);
});
await check("a tampered signature is rejected", async () => {
  const token = await auth.createSessionToken();
  const [exp, sig] = token.split(".");
  const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
  assert.equal(await auth.verifySessionToken(`${exp}.${flipped}`), false);
});
await check("extending the expiry without re-signing is rejected", async () => {
  // The exact forgery an attacker would try: take a valid token, push the
  // expiry out. The signature covers the expiry, so it must not verify.
  const token = await auth.createSessionToken();
  const sig = token.slice(token.indexOf(".") + 1);
  assert.equal(await auth.verifySessionToken(`${Date.now() + 10_000_000}.${sig}`), false);
});
await check("an expired token is rejected", async () => {
  const past = Date.now() - auth.SESSION_TTL_MS - 1000;
  const token = await auth.createSessionToken(past);
  assert.equal(await auth.verifySessionToken(token), false);
});
await check("a token still inside its window is accepted", async () => {
  const almost = Date.now() - auth.SESSION_TTL_MS + 60_000;
  assert.equal(await auth.verifySessionToken(await auth.createSessionToken(almost)), true);
});
await check("garbage shapes are rejected, not thrown on", async () => {
  for (const t of ["...", "abc", ".", "abc.def", "12x.sig", `${Date.now() + 1000}`]) {
    assert.equal(await auth.verifySessionToken(t), false, `expected reject for ${JSON.stringify(t)}`);
  }
});
await check("changing the password invalidates existing sessions", async () => {
  const token = await auth.createSessionToken();
  assert.equal(await auth.verifySessionToken(token), true);
  process.env.APP_PASSWORD = "a different password";
  assert.equal(await auth.verifySessionToken(token), false, "old sessions must not survive a password change");
  process.env.APP_PASSWORD = "correct horse battery staple";
});

console.log("\nPublic paths");
await check("the login flow and Meta's own callbacks stay reachable", () => {
  for (const p of [
    "/login",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/meta/data-deletion",
    "/api/auth/meta/deauthorize",
    "/api/cron/sync",
  ]) {
    assert.equal(auth.isPublicPath(p), true, `${p} must be public`);
  }
});
await check("everything that shows data is gated", () => {
  for (const p of [
    "/", "/overview", "/upload", "/alerts", "/reporting", "/analysis/meta_x",
    "/api/upload", "/api/db/accounts", "/api/db/alerts", "/api/db/campaign-detail",
    "/api/sync/meta", "/api/ai/chat",
  ]) {
    assert.equal(auth.isPublicPath(p), false, `${p} must NOT be public`);
  }
});
await check("a public prefix cannot be used to smuggle a private path", () => {
  // "/loginsomething" must not inherit "/login"'s exemption.
  assert.equal(auth.isPublicPath("/loginx"), false);
  assert.equal(auth.isPublicPath("/api/auth/loginx"), false);
  assert.equal(auth.isPublicPath("/api/auth/meta/callback"), false);
});

console.log(`\n${pass} checks passed.`);
if (process.exitCode) console.log("SOME CHECKS FAILED");
