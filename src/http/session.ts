// The demo passcode gate: a signed session cookie amb_session=<expiry>.<hmac>.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "amb_session";
export const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

function sign(expiry: string, secret: string): string {
  return createHmac("sha256", secret).update(`${SESSION_COOKIE}.${expiry}`).digest("base64url");
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

export function issueSession(secret: string, nowMs: number): string {
  const expiry = String(Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SEC);
  return `${expiry}.${sign(expiry, secret)}`;
}

export function verifySession(value: string | undefined, secret: string, nowMs: number): boolean {
  if (!value) return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const [, expiry, mac] = m as unknown as [string, string, string];
  if (!safeEqual(mac, sign(expiry, secret))) return false;
  return Number(expiry) * 1000 > nowMs;
}

export function sessionCookie(value: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}${secure ? "; Secure" : ""}`;
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
