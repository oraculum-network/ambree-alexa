// The client IP used as the rate-limit key. It is never logged.

import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The socket address, or with TRUST_PROXY_HOPS=N (N >= 1) the N-th X-Forwarded-For
 * entry from the right (what our own proxies appended), falling back to the socket.
 */
export function clientIp(req: IncomingMessage, trustProxyHops: number): string {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (trustProxyHops < 1) return socketIp;
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : xff;
  if (!raw) return socketIp;
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const pick = entries[entries.length - trustProxyHops];
  return pick && isIP(pick) ? pick : socketIp;
}

/** Our own agent's MCP calls: from loopback, and not relayed by any proxy. */
export function isLocalUnproxied(req: IncomingMessage): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? "") && req.headers["x-forwarded-for"] === undefined;
}
