// Daily (UTC) caps on LLM turns and spend, in memory. At a cap the agent answers
// in offline mode until the next UTC day.

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
  now?: () => number;
}

export interface Budget {
  /** True while both caps have room for another LLM call. */
  available(): boolean;
  startTurn(): void;
  /** Add one LLM call's usage; returns its cost in USD. */
  addUsage(usage: Usage | undefined): number;
  snapshot(): { day: string; turns: number; usd: number };
}

export function createBudget(opts: BudgetOptions): Budget {
  const now = opts.now ?? Date.now;
  let day = "";
  let turns = 0;
  let usd = 0;
  const roll = () => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      turns = 0;
      usd = 0;
    }
  };
  return {
    available() {
      roll();
      return turns < opts.dailyTurns && usd < opts.dailyUsd;
    },
    startTurn() {
      roll();
      turns++;
    },
    addUsage(usage) {
      roll();
      if (!usage) return 0;
      const cost =
        typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
          ? usage.cost
          : ((usage.prompt_tokens ?? 0) * opts.priceInPerM + (usage.completion_tokens ?? 0) * opts.priceOutPerM) / 1_000_000;
      usd += cost;
      return cost;
    },
    snapshot() {
      roll();
      return { day, turns, usd };
    },
  };
}
