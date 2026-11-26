/**
 * Parakeet's reading of a phrase (`ParakeetBridge.swift`): its words before
 * the names it listens for (`raw`), each span the names replaced, and the
 * words after (`text`).
 */
export interface ParakeetReading {
  readonly raw: string;
  readonly replacements: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly text: string;
}

/** Below this, the rest of a span is not the rest of the name (#384's recordings: wrong 0–0.20, right 0.50 and up). */
const REST_SIMILARITY = 0.5;
/** A word of the span this alike is the name's own, spelt another way ("Katarina" for Katharina). */
const SAME_WORD = 0.75;

/** Lower case, without accents or punctuation, as words. */
const words = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .replaceAll('ß', 'ss')
    .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
};

const similarity = (a: string, b: string): number => {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - distance(a, b) / longest;
};

/** Consonants only, a doubled one once: "li" and "lee" are both "l". */
const consonants = (text: string): string =>
  text.replaceAll(/[aeiouy\s]/gu, '').replaceAll(/(.)\1+/gu, '$1');

/** Short names spelt another way share their consonants: still this alike ("li" for "lee", not "all"). */
const SHORT_SIMILARITY = 0.3;

/** A span word that is a name word: alike (`SAME_WORD`), or the name word and more ("Kleinod" for Klein). */
const nameWordAlike = (said: string, word: string): number =>
  word.length >= 4 && said.startsWith(word) ? 1 : similarity(said, word);

/** The span's words that are the name's own: for each word of the name, the likest span word that is it. */
const sharedWords = (
  said: ReadonlyArray<string>,
  name: ReadonlyArray<string>,
): { readonly name: ReadonlySet<number>; readonly said: ReadonlySet<number> } => {
  const fromSaid = new Set<number>();
  const fromName = new Set<number>();
  for (const [at, word] of name.entries()) {
    let best: { alike: number; at: number } | undefined;
    for (const [index, other] of said.entries()) {
      const alike = nameWordAlike(other, word);
      if (!fromSaid.has(index) && alike >= SAME_WORD && alike > (best?.alike ?? 0)) {
        best = { alike, at: index };
      }
    }
    if (best !== undefined) {
      fromSaid.add(best.at);
      fromName.add(at);
    }
  }
  return { name: fromName, said: fromSaid };
};

/**
 * Whether a replacement puts a name right rather than taking a word that
 * stood beside part of it. Where the span already says a word of the name
 * ("Anna in" → "Anna Lee", "Sara morgen" → "Sarah Novak", "at Klein" →
 * "David Klein"), the rest of the span has to sound like the rest of the
 * name: "Kapfmeder" for Karpfeneder, or the same consonants for a short
 * one ("Li" for Lee). A span that shares no word with the name is
 * Parakeet's to judge alone.
 */
export const putsNameRight = (from: string, to: string): boolean => {
  const said = words(from);
  const name = words(to);
  const shared = sharedWords(said, name);
  if (shared.name.size === 0) {
    return true;
  }
  const restSaid = said.filter((_, index) => !shared.said.has(index)).join(' ');
  const restName = name.filter((_, index) => !shared.name.has(index)).join(' ');
  const alike = similarity(restSaid, restName);
  return (
    alike >= REST_SIMILARITY ||
    (alike >= SHORT_SIMILARITY &&
      consonants(restSaid) !== '' &&
      consonants(restSaid) === consonants(restName))
  );
};

/** A name's letters, for how alike a span is to it as a whole. */
const letters = (text: string): string => words(text).join('');

/**
 * The part of a kept span the name stands for: a word at either end that
 * makes the span less like the name is one Parakeet took beside it
 * ("Thomas Kapfmeder um" → Thomas Karpfeneder, "um" kept), so it stays.
 */
const nameWithin = (
  from: string,
  to: string,
): { readonly after: string; readonly before: string; readonly span: string } => {
  const spanWords = from.split(' ');
  const count = words(to).length;
  const alike = (part: ReadonlyArray<string>) => similarity(letters(part.join(' ')), letters(to));
  let first = 0;
  let last = spanWords.length;
  while (last - first > count) {
    const whole = alike(spanWords.slice(first, last));
    if (alike(spanWords.slice(first, last - 1)) > whole) {
      last -= 1;
    } else if (alike(spanWords.slice(first + 1, last)) > whole) {
      first += 1;
    } else {
      break;
    }
  }
  return {
    after: spanWords.slice(last).join(' '),
    before: spanWords.slice(0, first).join(' '),
    span: spanWords.slice(first, last).join(' '),
  };
};

const CLOSING = /[.,!?;:…)\]}"”»]*$/u;
const OPENING = /^[([{"“«¿¡]*/u;

/** Where `span` stands in `text` as whole words, outside the ranges taken already. */
const spanAt = (
  text: string,
  span: string,
  taken: ReadonlyArray<{ readonly end: number; readonly start: number }>,
): number | undefined => {
  for (let at = text.indexOf(span); at >= 0; at = text.indexOf(span, at + 1)) {
    const end = at + span.length;
    const whole =
      (at === 0 || /\s/u.test(text[at - 1] ?? '')) &&
      (end === text.length || /\s/u.test(text[end] ?? ''));
    if (whole && taken.every((range) => end <= range.start || at >= range.end)) {
      return at;
    }
  }
  return undefined;
};

/**
 * A replacement as it goes into the phrase: the name for its part of the
 * span (`nameWithin`) when that part puts the name right
 * (`putsNameRight`), the punctuation around it kept; else the span as
 * Parakeet heard it.
 */
const replaced = (from: string, to: string): string => {
  const { after, before, span } = nameWithin(from, to);
  if (!putsNameRight(span, to)) {
    return from;
  }
  const spanWords = span.split(' ');
  const opening = OPENING.exec(spanWords[0] ?? '')?.[0] ?? '';
  const closing = CLOSING.exec(spanWords.at(-1) ?? '')?.[0] ?? '';
  return [before, `${opening}${to}${closing}`, after].filter(Boolean).join(' ');
};

/**
 * The phrase as Parakeet read it, with each replacement only where it puts
 * a name right (`replaced`): Parakeet's own text when that changes
 * nothing, else its words before the names with the replacements put in
 * where their spans stand (whole words; FluidAudio lists them by how alike
 * they are, not in order).
 */
export const parakeetText = (reading: ParakeetReading): string => {
  if (
    reading.replacements.every(
      ({ from, to }) => nameWithin(from, to).span === from && putsNameRight(from, to),
    )
  ) {
    return reading.text;
  }
  const spans: Array<{ end: number; start: number; text: string }> = [];
  for (const { from, to } of reading.replacements) {
    const start = spanAt(reading.raw, from, spans);
    if (start === undefined) {
      // Not among its words: the replacements cannot be told apart from the text.
      return reading.raw;
    }
    spans.push({ end: start + from.length, start, text: replaced(from, to) });
  }
  let text = '';
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    text += reading.raw.slice(at, span.start) + span.text;
    at = span.end;
  }
  return text + reading.raw.slice(at);
};
