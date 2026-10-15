// Fetch with a hard timeout and a streamed body-size cap, for the public feeds.

export const FEED_TIMEOUT_MS = 4000;
export const FEED_MAX_BYTES = 1024 * 1024;

export type FetchFailure = "timeout" | "network" | "too_big";

export class FeedFetchError extends Error {
  override name = "FeedFetchError";
  readonly kind: FetchFailure;
  constructor(kind: FetchFailure) {
    super(kind);
    this.kind = kind;
  }
}

export interface FetchedText {
  status: number;
  headers: Headers;
  text: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchCapped(
  url: string,
  headers: Record<string, string>,
  opts: { timeoutMs?: number; maxBytes?: number; fetch?: FetchLike } = {},
): Promise<FetchedText> {
  const timeoutMs = opts.timeoutMs ?? FEED_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? FEED_MAX_BYTES;
  const doFetch = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
    const declared = Number(res.headers.get("content-length") || "0");
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new FeedFetchError("too_big");
    }
    if (res.status === 304 || res.status === 204 || !res.body) return { status: res.status, headers: res.headers, text: "" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FeedFetchError("too_big");
      }
      chunks.push(value);
    }
    return { status: res.status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") };
  } catch (e) {
    if (e instanceof FeedFetchError) throw e;
    if (ctrl.signal.aborted) throw new FeedFetchError("timeout");
    throw new FeedFetchError("network");
  } finally {
    clearTimeout(timer);
  }
}
