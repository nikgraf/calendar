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
/** A span whose letters are this alike to the name's says the name, split or joined another way ("Mc Donald"). */
const SAME_LETTERS = 0.9;
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
 * one ("Li" for Lee). A span that spells the name's letters with other
 * word breaks ("Anna Mc Donald") puts it right, and one that shares no word
 * with the name is Parakeet's to judge alone.
 */
export const putsNameRight = (from: string, to: string): boolean => {
  const said = words(from);
  const name = words(to);
  if (similarity(said.join(''), name.join('')) >= SAME_LETTERS) {
    return true;
  }
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
  const count = to.split(' ').filter(Boolean).length;
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

/** Where `span` stands in `text` as whole words. */
const wholeAt = (text: string, span: string): ReadonlyArray<number> => {
  const found: Array<number> = [];
  for (let at = text.indexOf(span); at >= 0 && span !== ''; at = text.indexOf(span, at + 1)) {
    const end = at + span.length;
    if (
      (at === 0 || /\s/u.test(text[at - 1] ?? '')) &&
      (end === text.length || /\s/u.test(text[end] ?? ''))
    ) {
      found.push(at);
    }
  }
  return found;
};

/**
 * The replacement as FluidAudio writes it (`preservingBoundaryPunctuation`):
 * the name with the punctuation around the span kept, less what the name
 * already ends or starts with ("Jr." before ".," adds only ",").
 */
const written = (span: string, to: string): string => {
  const spanWords = span.split(' ').filter(Boolean);
  const first = spanWords[0] ?? '';
  const last = spanWords.at(-1) ?? '';
  const closing = CLOSING.exec(last)?.[0] ?? '';
  const opening = OPENING.exec(first)?.[0] ?? '';
  // A span of punctuation alone has no word boundary to keep.
  if (to === '' || closing.length >= last.length || opening.length >= first.length) {
    return to;
  }
  let closed = closing.length;
  while (closed > 0 && !to.endsWith(closing.slice(0, closed))) {
    closed -= 1;
  }
  let opened = opening.length;
  while (opened > 0 && !to.startsWith(opening.slice(opening.length - opened))) {
    opened -= 1;
  }
  return `${opening.slice(0, opening.length - opened)}${to}${closing.slice(closed)}`;
};

interface Placed {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

/** `raw` with each placed span's text put in where it stands. */
const rebuilt = (raw: string, placed: ReadonlyArray<Placed>): string => {
  let text = '';
  let at = 0;
  for (const span of [...placed].sort((a, b) => a.start - b.start)) {
    text += raw.slice(at, span.start) + span.text;
    at = span.end;
  }
  return text + raw.slice(at);
};

const singleSpaced = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();

/** Placements of a span tried at most, so a phrase with many repeats stays quick. */
const MAX_TRIES = 500;

/**
 * Where each replacement's span stands in `raw` (FluidAudio lists them by
 * how alike they are, not in order, and a span can stand twice): the
 * placing whose replacements give Parakeet's own text, else each at its
 * first free place. Undefined when a span is not among the words.
 */
const placements = (reading: ParakeetReading): ReadonlyArray<number> | undefined => {
  const options = reading.replacements.map(({ from }) => wholeAt(reading.raw, from));
  if (options.some((each) => each.length === 0)) {
    return undefined;
  }
  const target = singleSpaced(reading.text);
  let tries = 0;
  const chosen: Array<number> = [];
  const free = (index: number, start: number): boolean =>
    chosen.every((other, at) => {
      const end = start + (reading.replacements[index]?.from.length ?? 0);
      return end <= other || start >= other + (reading.replacements[at]?.from.length ?? 0);
    });
  const search = (index: number): boolean => {
    if (index === reading.replacements.length) {
      const placed = reading.replacements.map(({ from, to }, at) => ({
        end: (chosen[at] ?? 0) + from.length,
        start: chosen[at] ?? 0,
        text: written(from, to),
      }));
      return singleSpaced(rebuilt(reading.raw, placed)) === target;
    }
    for (const start of options[index] ?? []) {
      tries += 1;
      if (tries > MAX_TRIES) {
        return false;
      }
      if (free(index, start)) {
        chosen.push(start);
        if (search(index + 1)) {
          return true;
        }
        chosen.pop();
      }
    }
    return false;
  };
  if (search(0)) {
    return chosen;
  }
  chosen.length = 0;
  for (const [index, starts] of options.entries()) {
    const start = starts.find((each) => free(index, each));
    if (start === undefined) {
      return undefined;
    }
    chosen.push(start);
  }
  return chosen;
};

/**
 * A replacement as it goes into the phrase: the name for its part of the
 * span (`nameWithin`) when that part puts the name right
 * (`putsNameRight`), the punctuation around it kept; else the span as
 * Parakeet heard it.
 */
const replaced = (from: string, to: string): string => {
  const { after, before, span } = nameWithin(from, to);
  return putsNameRight(span, to)
    ? [before, written(span, to), after].filter(Boolean).join(' ')
    : from;
};

/**
 * The phrase as Parakeet read it, with each replacement only where it puts
 * a name right (`replaced`): Parakeet's own text when that changes
 * nothing, else its words before the names with the replacements put in
 * where their spans stand (`placements`).
 */
export const parakeetText = (reading: ParakeetReading): string => {
  if (
    reading.replacements.every(
      ({ from, to }) => nameWithin(from, to).span === from && putsNameRight(from, to),
    )
  ) {
    return reading.text;
  }
  const starts = placements(reading);
  if (starts === undefined) {
    // Not among its words: the replacements cannot be told apart from the text.
    return reading.raw;
  }
  return rebuilt(
    reading.raw,
    reading.replacements.map(({ from, to }, index) => ({
      end: (starts[index] ?? 0) + from.length,
      start: starts[index] ?? 0,
      text: replaced(from, to),
    })),
  );
};
