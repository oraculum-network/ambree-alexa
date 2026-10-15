// Accent-insensitive, typo-tolerant matching for area and place names.

/** "Mahébourg!" -> "mahebourg"; "L'Aventure du Sucre" -> "l aventure du sucre". */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[’'`]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Drop a leading article so "the Blue Penny Museum" matches "Blue Penny Museum". */
export function stripArticle(s: string): string {
  return s.replace(/^(the|a|an|le|la|les|l)\s+/, "");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/** True when `phrase` occurs in `text` on word boundaries (both normalized). */
export function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

/**
 * Score how well a query matches one label (both normalized), 0..1:
 * exact 1, the query contains the label 0.92, the label starts with or contains the
 * query 0.85/0.8, else edit similarity (whole string or best word window) scaled.
 */
export function matchScore(query: string, label: string): number {
  const q = stripArticle(query);
  const l = stripArticle(label);
  if (!q || !l) return 0;
  if (q === l) return 1;
  if (containsPhrase(q, l) && l.length >= 4) return 0.92;
  if (q.length >= 4 && l.startsWith(q + " ")) return 0.85;
  if (q.length >= 4 && containsPhrase(l, q)) return 0.8;
  let best = similarity(q, l);
  // Compare against windows of the label with as many words as the query (typos in a part).
  const qw = q.split(" ");
  const lw = l.split(" ");
  if (lw.length > qw.length) {
    for (let i = 0; i + qw.length <= lw.length; i++) {
      best = Math.max(best, similarity(q, lw.slice(i, i + qw.length).join(" ")) * 0.9);
    }
  }
  return best >= 0.72 ? best * 0.78 : best * 0.5;
}

export interface Candidate<T> {
  item: T;
  labels: string[]; // already normalized
}

export function rank<T>(query: string, candidates: Candidate<T>[]): Array<{ item: T; score: number }> {
  const q = normalize(query);
  return candidates
    .map((c) => ({ item: c.item, score: Math.max(0, ...c.labels.map((l) => matchScore(q, l))) }))
    .sort((a, b) => b.score - a.score);
}

/** Accept a match at or above this score (exact, containment, or a close typo). */
export const MATCH_THRESHOLD = 0.56;

export function bestMatch<T>(query: string, candidates: Candidate<T>[]): T | null {
  const top = rank(query, candidates)[0];
  return top && top.score >= MATCH_THRESHOLD ? top.item : null;
}

/**
 * Find labels mentioned inside free text (for the offline router), longest first.
 * Returns the item whose label is the longest phrase found in `text`.
 */
export function findInText<T>(text: string, candidates: Candidate<T>[], minLength = 4): T | null {
  const t = normalize(text);
  let best: { item: T; len: number } | null = null;
  for (const c of candidates) {
    for (const l of c.labels) {
      if (l.length < minLength) continue;
      const variants = [l, stripArticle(l)];
      for (const v of variants) {
        if (v.length >= minLength && containsPhrase(t, v) && (!best || v.length > best.len)) best = { item: c.item, len: v.length };
      }
    }
  }
  return best?.item ?? null;
}
