// Request bodies: JSON only, with a hard size limit.

import type { IncomingMessage } from "node:http";

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415; message: string };

export function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(";")[0]!.trim().toLowerCase() === "application/json";
}

export async function readJsonBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  if (!isJsonContentType(req.headers["content-type"])) {
    return { ok: false, status: 415, message: "Content-Type must be application/json" };
  }
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > limit) return { ok: false, status: 413, message: `Request body is larger than ${limit} bytes` };
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > limit) return { ok: false, status: 413, message: `Request body is larger than ${limit} bytes` };
      chunks.push(buf);
    }
  } catch {
    return { ok: false, status: 400, message: "Could not read the request body" };
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON" };
  }
}
