// Who is asking, for rate limits: the client key is never logged.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Logger } from "../log.ts";

/** The header that marks the agent's own MCP calls. Its value is a random per-process token. */
export const INTERNAL_HEADER = "x-ambree-internal";

/**
 * An X-Forwarded-For entry as an address: proxies may append "ip:port", "[v6]" or
 * "[v6]:port" rather than a bare IP.
 */
export function cleanForwardedEntry(entry: string): string {
  const e = entry.trim().replace(/^"|"$/g, "");
  if (e.startsWith("[")) {
    const end = e.indexOf("]");
    return end > 0 ? e.slice(1, end) : e;
  }
  const colons = e.split(":").length - 1;
  return colons === 1 ? e.slice(0, e.indexOf(":")) : e;
}

/** Expand an IPv6 address into its 8 hextets (handles "::" and an IPv4 tail). */
function hextets(ip: string): number[] | null {
  let addr = ip.toLowerCase().split("%")[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split(".").map(Number) as [number, number, number, number];
    addr = addr.slice(0, -v4[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => parseInt(p, 16));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

/**
 * The rate-limit key for an address. IPv6 clients are keyed by their /64, since one home or
 * phone network hands out a whole /64; IPv4-mapped IPv6 ("::ffff:a.b.c.d") is keyed as IPv4.
 */
export function rateKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const h = hextets(ip);
  if (!h) return ip;
  return `${h.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
}

export interface ClientIdentity {
  /** The rate-limit key for this request. */
  key(req: IncomingMessage): string;
  /** The agent's own MCP calls: the per-process token, and not relayed by any proxy. */
  isInternal(req: IncomingMessage): boolean;
}

/**
 * The client address is the socket address, or with TRUST_PROXY_HOPS=N (N >= 1) the N-th
 * X-Forwarded-For entry from the right (what our own proxies appended), falling back to the
 * socket when that entry isn't an address (logged once, without the value).
 */
export function createClientIdentity(opts: { trustProxyHops: number; internalToken: string; log: Logger }): ClientIdentity {
  let warned = false;
  const token = Buffer.from(opts.internalToken);

  function address(req: IncomingMessage): string {
    const socketIp = req.socket.remoteAddress ?? "unknown";
    if (opts.trustProxyHops < 1) return socketIp;
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff.join(",") : xff;
    if (!raw) return socketIp;
    const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const pick = entries[entries.length - opts.trustProxyHops];
    if (!pick) return socketIp;
    const ip = cleanForwardedEntry(pick);
    if (isIP(ip)) return ip;
    if (!warned) {
      warned = true;
      opts.log({ level: "warn", event: "xff_not_ip", hops: opts.trustProxyHops });
    }
    return socketIp;
  }

  return {
    key: (req) => rateKey(address(req)),
    isInternal(req) {
      const given = req.headers[INTERNAL_HEADER];
      if (typeof given !== "string" || req.headers["x-forwarded-for"] !== undefined) return false;
      const g = Buffer.from(given);
      return g.length === token.length && timingSafeEqual(g, token);
    },
  };
}
