// The demo passcode gate: a signed session cookie amb_session=<expiry>.<hmac>.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "amb_session";
export const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

/**
 * On https the cookie is "__Host-amb_session": browsers then require Secure, Path=/ and
 * no Domain, so a sibling subdomain can't set a cookie that shadows it.
 */
export function sessionCookieName(https: boolean): string {
  return https ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

/** The MAC binds the expiry and the passcode (hashed), so changing the passcode ends every session. */
function sign(expiry: string, secret: string, passcode: string): string {
  const passcodeHash = createHash("sha256").update(passcode).digest("hex");
  return createHmac("sha256", secret).update(`${SESSION_COOKIE}.${expiry}.${passcodeHash}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Constant-time passcode check (hash both sides so lengths never leak). */
export function passcodeMatches(given: string, expected: string): boolean {
  const g = createHash("sha256").update(given).digest();
  const e = createHash("sha256").update(expected).digest();
  return timingSafeEqual(g, e);
}

export function issueSession(secret: string, nowMs: number, passcode: string): string {
  const expiry = String(Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SEC);
  return `${expiry}.${sign(expiry, secret, passcode)}`;
}

export function verifySession(value: string | undefined, secret: string, nowMs: number, passcode: string): boolean {
  if (!value) return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const [, expiry, mac] = m as unknown as [string, string, string];
  if (!safeEqual(mac, sign(expiry, secret, passcode))) return false;
  return Number(expiry) * 1000 > nowMs;
}

export function sessionCookie(value: string, https: boolean): string {
  return `${sessionCookieName(https)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}${https ? "; Secure" : ""}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
