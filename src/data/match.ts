// Accent-insensitive, typo-tolerant matching for area and place names.

/**
 * "Mahébourg!" -> "mahebourg"; "L'Aventure du Sucre" -> "laventure du sucre". Apostrophes
 * are dropped rather than spaced, so "Pointe 'Esny" is one edit from "Pointe d'Esny".
 */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Drop a leading article so "the Blue Penny Museum" matches "Blue Penny Museum". */
export function stripArticle(s: string): string {
  return s.replace(/^(the|a|an|le|la|les|l)\s+/, "");
}

/**
 * Optimal-string-alignment (restricted Damerau-Levenshtein) distance: insertions, deletions,
 * substitutions and swaps of two adjacent letters each cost 1, so "Mahebuorg" is one edit
 * from "Mahebourg", as a typist would count it.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j]!, prev2[j - 2]! + 1);
    }
    prev2 = prev;
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

/** Typos tolerated: one edit per 8 characters of the label, and always at least one. */
export function editsAllowed(label: string): number {
  return Math.max(1, Math.floor(label.length / 8));
}

/** Partial matches (containment, prefix, part of a label) need this many characters. */
const MIN_PARTIAL = 5;

/**
 * Score how well a query matches one label (both normalized), 0..1:
 *  - exact: 1;
 *  - the query contains the whole label: 0.92;
 *  - the label starts with, or contains, the query (5+ characters): 0.85 / 0.8;
 *  - a typo within editsAllowed of the label: 0.6, or of a same-length part of it: 0.58.
 * Anything else scores below MATCH_THRESHOLD (similarity x 0.5, for ranking suggestions).
 * So "port luis", "Chamrel" and "Flic n Flac" match, but "Grand Bassin" (3 edits from
 * "grand baie"), "Grand Bois", "Bay" and "Mont" don't.
 */
export function matchScore(query: string, label: string): number {
  const q = stripArticle(query);
  const l = stripArticle(label);
  if (!q || !l) return 0;
  if (q === l) return 1;
  if (l.length >= 4 && containsPhrase(q, l)) return 0.92;
  if (q.length >= MIN_PARTIAL && l.startsWith(q + " ")) return 0.85;
  if (q.length >= MIN_PARTIAL && containsPhrase(l, q)) return 0.8;
  if (levenshtein(q, l) <= editsAllowed(l)) return 0.6;
  // A typo in one part of a longer label ("souilac" for "souillac and bel ombre").
  const qw = q.split(" ");
  const lw = l.split(" ");
  if (q.length >= MIN_PARTIAL && lw.length > qw.length) {
    for (let i = 0; i + qw.length <= lw.length; i++) {
      const part = lw.slice(i, i + qw.length).join(" ");
      if (levenshtein(q, part) <= editsAllowed(part)) return 0.58;
    }
  }
  return similarity(q, l) * 0.5;
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

/** The best candidate at or above MATCH_THRESHOLD, with its score. */
export function bestScored<T>(query: string, candidates: Candidate<T>[]): { item: T; score: number } | null {
  const top = rank(query, candidates)[0];
  return top && top.score >= MATCH_THRESHOLD ? top : null;
}

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
