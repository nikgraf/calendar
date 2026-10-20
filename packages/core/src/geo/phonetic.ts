import { foldSearchText } from '../search/match.ts';

/**
 * Kölner Phonetik: a key under which words that sound alike in German
 * (and well enough in English names) read the same — "Zentral" and
 * "Central", "Kaffee" and "Café", "Blachutta" and "Plachutta",
 * "Stefansdom" and "Stephansdom". Dictation spells a place as heard, so a
 * past location is found by how it sounds, where MapKit's search is not.
 */

const VOWELS = new Set(['a', 'e', 'i', 'j', 'o', 'u', 'y']);

/** The code of the letter at `index`, by its neighbours. */
const codeOf = (word: string, index: number): string => {
  const letter = word[index]!;
  const before = word[index - 1] ?? '';
  const after = word[index + 1] ?? '';
  if (VOWELS.has(letter)) {
    return '0';
  }
  switch (letter) {
    case 'h':
      return '';
    case 'b':
      return '1';
    case 'p':
      return after === 'h' ? '3' : '1';
    case 'd':
    case 't':
      return 'csz'.includes(after) && after !== '' ? '8' : '2';
    case 'f':
    case 'v':
    case 'w':
      return '3';
    case 'g':
    case 'k':
    case 'q':
      return '4';
    case 'c':
      if (index === 0) {
        return 'ahkloqrux'.includes(after) && after !== '' ? '4' : '8';
      }
      if (before === 's' || before === 'z') {
        return '8';
      }
      return 'ahkoqux'.includes(after) && after !== '' ? '4' : '8';
    case 'x':
      return 'ckq'.includes(before) && before !== '' ? '8' : '48';
    case 'l':
      return '5';
    case 'm':
    case 'n':
      return '6';
    case 'r':
      return '7';
    case 's':
    case 'z':
      return '8';
    default:
      return '';
  }
};

/** The key of one word: its codes, runs collapsed, zeros dropped but a leading one. */
const wordKey = (word: string): string => {
  const letters = word.replaceAll(/[^a-z]/g, '');
  let raw = '';
  for (let index = 0; index < letters.length; index += 1) {
    raw += codeOf(letters, index);
  }
  let collapsed = '';
  for (const code of raw) {
    if (code !== collapsed.at(-1)) {
      collapsed += code;
    }
  }
  return collapsed.slice(0, 1) + collapsed.slice(1).replaceAll('0', '');
};

/**
 * The phonetic key of a text: one key per word, in order, words without
 * letters (a house number) left out. Case, accents and ß do not count.
 */
export const koelnerKey = (text: string): string =>
  foldSearchText(text)
    .replaceAll('ß', 'ss')
    .split(/[^\p{L}\p{N}]+/u)
    .map(wordKey)
    .filter((key) => key !== '')
    .join(' ');
