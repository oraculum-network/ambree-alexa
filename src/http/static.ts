// Static files from public/ only: no traversal, no dotfiles, known types only.

import { readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { PAGE_CSP } from "./headers.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export const ASSET_MAX_AGE_SEC = 3600;

export type StaticLookup = { ok: true; file: string; type: string } | { ok: false; status: 400 | 404 };

/** Map a URL path to a file inside `root`, refusing anything outside it or hidden. */
export async function resolveStatic(root: string, urlPath: string): Promise<StaticLookup> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { ok: false, status: 400 };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return { ok: false, status: 400 };
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((s) => s.startsWith("."))) return { ok: false, status: 404 };
  const file = path.resolve(root, ...segments);
  if (file !== root && !file.startsWith(root + path.sep)) return { ok: false, status: 404 };
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return { ok: false, status: 404 };
  try {
    const real = await realpath(file);
    if (!real.startsWith(root + path.sep)) return { ok: false, status: 404 };
    if (!(await stat(real)).isFile()) return { ok: false, status: 404 };
    return { ok: true, file: real, type };
  } catch {
    return { ok: false, status: 404 };
  }
}

export async function sendFile(res: ServerResponse, file: string, type: string, head: boolean): Promise<void> {
  const body = await readFile(file);
  const isHtml = type.startsWith("text/html");
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": String(body.length),
    "Cache-Control": isHtml ? "no-cache" : `public, max-age=${ASSET_MAX_AGE_SEC}`,
    ...(isHtml ? { "Content-Security-Policy": PAGE_CSP } : {}),
  });
  res.end(head ? undefined : body);
}
