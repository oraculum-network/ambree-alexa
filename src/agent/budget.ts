// Daily (UTC) caps on LLM turns and spend, in memory, plus a cap on LLM turns in flight.
// At a cap the agent answers in offline mode until the next UTC day.
//
// Spend is reserved before each LLM call, synchronously (no await between the check and
// the reservation), then settled at the call's real cost. The reservation is the larger of
// a worst-case estimate from the configured prices and the most expensive call seen so far,
// so a model or provider dearer than the prices suggest is a surprise only once per slot:
// the total stays within the cap plus one reservation per in-flight turn.

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

export interface BudgetOptions {
  dailyUsd: number;
  dailyTurns: number;
  priceInPerM: number;
  priceOutPerM: number;
  /** LLM turns allowed at the same time; more answer offline. */
  maxInflight?: number;
  /** LLM turns one client (rate-limit key) may have at the same time. */
  maxPerClient?: number;
  now?: () => number;
}

export type TurnGate = { ok: true } | { ok: false; reason: "budget" | "busy" | "client_busy" };

export interface Budget {
  /** True while both daily caps have room. */
  available(): boolean;
  /** Start an LLM turn for a client: counts it and takes an in-flight slot, or says why not. */
  beginTurn(clientKey: string): TurnGate;
  /** Give back the in-flight slot taken by beginTurn. */
  endTurn(clientKey: string): void;
  /** Worst-case USD for one call: the price estimate, or the dearest call seen so far if more. */
  reservationFor(promptChars: number, maxOutputTokens: number): number;
  /** Reserve `usd` if the daily cap has room. Synchronous. */
  tryReserve(usd: number): boolean;
  /** Replace a reservation with the real cost. */
  settle(reserved: number, actual: number): void;
  /** The real cost of a call from its usage (usage.cost, else a token estimate); null if unknown. */
  costOf(usage: Usage | undefined): number | null;
  snapshot(): { day: string; turns: number; usd: number; inflight: number; maxSeen: number };
}

/** Prompt tokens are estimated from characters at 3 per token, which over-counts on purpose. */
const CHARS_PER_TOKEN = 3;

export function createBudget(opts: BudgetOptions): Budget {
  const now = opts.now ?? Date.now;
  const maxInflight = opts.maxInflight ?? 3;
  const maxPerClient = opts.maxPerClient ?? 1;
  // Only clients with a turn in flight are in the map, so it holds at most maxInflight keys.
  const byClient = new Map<string, number>();
  let day = "";
  let turns = 0;
  let usd = 0;
  let inflight = 0;
  /** The dearest single call settled so far (kept across days: prices don't reset at midnight). */
  let maxSeen = 0;
  const roll = () => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      turns = 0;
      usd = 0;
    }
  };
  const available = () => {
    roll();
    return turns < opts.dailyTurns && usd < opts.dailyUsd;
  };
  return {
    available,
    beginTurn(clientKey) {
      if (!available()) return { ok: false, reason: "budget" };
      if ((byClient.get(clientKey) ?? 0) >= maxPerClient) return { ok: false, reason: "client_busy" };
      if (inflight >= maxInflight) return { ok: false, reason: "busy" };
      inflight++;
      byClient.set(clientKey, (byClient.get(clientKey) ?? 0) + 1);
      turns++;
      return { ok: true };
    },
    endTurn(clientKey) {
      inflight = Math.max(0, inflight - 1);
      const left = (byClient.get(clientKey) ?? 1) - 1;
      if (left > 0) byClient.set(clientKey, left);
      else byClient.delete(clientKey);
    },
    reservationFor(promptChars, maxOutputTokens) {
      const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
      const estimate = (promptTokens * opts.priceInPerM + maxOutputTokens * opts.priceOutPerM) / 1_000_000;
      return Math.max(estimate, maxSeen);
    },
    tryReserve(amount) {
      roll();
      if (usd >= opts.dailyUsd) return false;
      usd += amount;
      return true;
    },
    settle(reserved, actual) {
      roll();
      maxSeen = Math.max(maxSeen, actual);
      usd = Math.max(0, usd - reserved + actual);
    },
    costOf(usage) {
      if (!usage) return null;
      if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) return usage.cost;
      if (typeof usage.prompt_tokens !== "number" && typeof usage.completion_tokens !== "number") return null;
      return ((usage.prompt_tokens ?? 0) * opts.priceInPerM + (usage.completion_tokens ?? 0) * opts.priceOutPerM) / 1_000_000;
    },
    snapshot() {
      roll();
      return { day, turns, usd, inflight, maxSeen };
    },
  };
}
