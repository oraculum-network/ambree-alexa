// Text written for the ear: at most 2 sentences and 280 characters, no markdown,
// URLs, emoji or abbreviations, and numbers that read well aloud.

export const SPEECH_MAX_CHARS = 280;
export const SPEECH_MAX_SENTENCES = 2;

const NUMBER_WORDS = ["twelve", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"];

/** Strip markdown, links, URLs and emoji; collapse whitespace. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g, "$1$2")
    .replace(/[*#>|~]/g, " ")
    .replace(/(?<!\w)_|_(?!\w)/g, " ")
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

/** Sentences, split after . ! or ? followed by a space. */
export function sentences(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  return t.split(/(?<=[.!?])\s+(?=\S)/).filter(Boolean);
}

/** Plain text capped at `maxSentences` and `maxChars`, ending cleanly. */
export function capSpeech(text: string, maxSentences = SPEECH_MAX_SENTENCES, maxChars = SPEECH_MAX_CHARS): string {
  let out = sentences(plainText(text)).slice(0, maxSentences).join(" ");
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars - 1);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (lastStop > maxChars / 3) {
      out = cut.slice(0, lastStop + 1);
    } else {
      const lastSpace = cut.lastIndexOf(" ");
      out = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s-]+$/, "") + ".";
    }
  }
  if (out && !/[.!?]$/.test(out)) out += ".";
  return out;
}

/** Pick the first candidate that fits the speech limits as written, else cap the last one. */
export function fitSpeech(...candidates: string[]): string {
  for (const c of candidates) {
    const plain = plainText(c);
    if (plain.length <= SPEECH_MAX_CHARS && sentences(plain).length <= SPEECH_MAX_SENTENCES) return capSpeech(plain);
  }
  return capSpeech(candidates[candidates.length - 1] ?? "");
}

/** "three", "noon", "midnight" */
export function clockWord(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return "midnight";
  if (h === 12) return "noon";
  return NUMBER_WORDS[h % 12] ?? String(h);
}

/** "three in the afternoon", "nine at night", "noon" */
export function spokenTime(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0 || h === 12) return clockWord(h);
  if (h < 5) return `${clockWord(h)} at night`;
  if (h < 12) return `${clockWord(h)} in the morning`;
  if (h < 18) return `${clockWord(h)} in the afternoon`;
  if (h < 21) return `${clockWord(h)} in the evening`;
  return `${clockWord(h)} at night`;
}

/** "about 20 minutes", "about an hour", "about an hour and a half", "about 2 hours" */
export function spokenDuration(minutes: number): string {
  if (minutes < 60) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  const halfHours = Math.round(minutes / 30);
  if (halfHours === 2) return "about an hour";
  if (halfHours === 3) return "about an hour and a half";
  const hours = halfHours / 2;
  return Number.isInteger(hours) ? `about ${hours} hours` : `about ${Math.floor(hours)} and a half hours`;
}

export function degrees(c: number): string {
  const n = Math.round(c);
  return `${n} ${Math.abs(n) === 1 ? "degree" : "degrees"}`;
}

/** "A", "A and B", "A, B and C" */
export function joinNames(names: string[], conj = "and"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${conj} ${names[names.length - 1]}`;
}

export function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
