// Daily (UTC) caps on LLM turns and spend, in memory, plus a cap on LLM turns in flight.
// At a cap the agent answers in offline mode until the next UTC day.
//
// Spend is reserved before each LLM call, synchronously (no await between the check and
// the reservation), at a worst-case estimate; the call then settles it at its real cost.
// So concurrent turns can't all pass the check before any of them is charged: the total
// stays within the cap plus one reservation.

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
  now?: () => number;
}

export type TurnGate = { ok: true } | { ok: false; reason: "budget" | "busy" };

export interface Budget {
  /** True while both daily caps have room. */
  available(): boolean;
  /** Start an LLM turn: counts it and takes an in-flight slot, or says why not. */
  beginTurn(): TurnGate;
  /** Give back the in-flight slot taken by beginTurn. */
  endTurn(): void;
  /** Worst-case USD for one call with this much prompt text and this output cap. */
  reservationFor(promptChars: number, maxOutputTokens: number): number;
  /** Reserve `usd` if the daily cap has room. Synchronous. */
  tryReserve(usd: number): boolean;
  /** Replace a reservation with the real cost. */
  settle(reserved: number, actual: number): void;
  /** The real cost of a call from its usage (usage.cost, else a token estimate); null if unknown. */
  costOf(usage: Usage | undefined): number | null;
  snapshot(): { day: string; turns: number; usd: number; inflight: number };
}

/** Prompt tokens are estimated from characters at 3 per token, which over-counts on purpose. */
const CHARS_PER_TOKEN = 3;

export function createBudget(opts: BudgetOptions): Budget {
  const now = opts.now ?? Date.now;
  const maxInflight = opts.maxInflight ?? 3;
  let day = "";
  let turns = 0;
  let usd = 0;
  let inflight = 0;
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
    beginTurn() {
      if (!available()) return { ok: false, reason: "budget" };
      if (inflight >= maxInflight) return { ok: false, reason: "busy" };
      inflight++;
      turns++;
      return { ok: true };
    },
    endTurn() {
      inflight = Math.max(0, inflight - 1);
    },
    reservationFor(promptChars, maxOutputTokens) {
      const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
      return (promptTokens * opts.priceInPerM + maxOutputTokens * opts.priceOutPerM) / 1_000_000;
    },
    tryReserve(amount) {
      roll();
      if (usd >= opts.dailyUsd) return false;
      usd += amount;
      return true;
    },
    settle(reserved, actual) {
      roll();
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
      return { day, turns, usd, inflight };
    },
  };
}
