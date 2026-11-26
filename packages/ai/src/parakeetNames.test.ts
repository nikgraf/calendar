import { describe, expect, it } from 'vite-plus/test';
import { parakeetText, putsNameRight } from './parakeetNames.ts';

// Parakeet's readings of Nik's recordings (#384), with the address book as its names.
describe('putsNameRight', () => {
  it('keeps a name it heard almost right', () => {
    expect(putsNameRight('Thomas Kapfmeder', 'Thomas Karpfeneder')).toBe(true);
    expect(putsNameRight('Thomas Kaufmeter', 'Thomas Karpfeneder')).toBe(true);
    expect(putsNameRight('Thomas Kapfmeder im', 'Thomas Karpfeneder')).toBe(true);
    expect(putsNameRight('Jörg Hofstädter.', 'Jörg Hofstätter')).toBe(true);
    expect(putsNameRight('Katarina Gruber', 'Katharina Gruber')).toBe(true);
    expect(putsNameRight('Emily Carters,', 'Emily Carter')).toBe(true);
  });

  it('leaves a span that shares no word with the name to Parakeet', () => {
    expect(putsNameRight('Weltthomas Kapfmeder.', 'Thomas Karpfeneder')).toBe(true);
  });

  it('drops a first name said alone that took the next word into a full name', () => {
    expect(putsNameRight('Sarah morgen', 'Sarah Novak')).toBe(false);
    expect(putsNameRight('Anna in', 'Anna Lee')).toBe(false);
    expect(putsNameRight('Anna from', 'Anna Lee')).toBe(false);
    expect(putsNameRight('tom at', 'Tom Baker')).toBe(false);
    expect(putsNameRight('at Klein', 'David Klein')).toBe(false);
  });

  it('takes a first name spelt another way for the name’s own', () => {
    expect(putsNameRight('Katarina morgen', 'Katharina Gruber')).toBe(false);
    expect(putsNameRight('Sara morgen', 'Sarah Novak')).toBe(false);
  });

  it('keeps a name heard with other word breaks', () => {
    expect(putsNameRight('Anna Mc Donald', 'Anna McDonald')).toBe(true);
  });

  it('takes a word that begins with a name word for that word', () => {
    expect(putsNameRight('at Kleinod', 'David Klein')).toBe(false);
  });

  it('keeps a short surname heard with the same consonants, and not a word that only shares them', () => {
    expect(putsNameRight('Anna Li', 'Anna Lee')).toBe(true);
    expect(putsNameRight('Tom Woo', 'Tom Wu')).toBe(true);
    expect(putsNameRight('Anna all', 'Anna Lee')).toBe(false);
  });

  it('drops a name that adds a word to one said in full', () => {
    expect(putsNameRight('Anna', 'Anna Lee')).toBe(false);
  });
});

describe('parakeetText', () => {
  it('is Parakeet’s own text when every replacement stays', () => {
    const reading = {
      raw: 'Pick up Thomas Kaufmeter at Haupternhof on Thursday at six.',
      replacements: [{ from: 'Thomas Kaufmeter', to: 'Thomas Karpfeneder' }],
      text: 'Pick up Thomas Karpfeneder at Haupternhof on Thursday at six.',
    };
    expect(parakeetText(reading)).toBe(reading.text);
  });

  it('puts the words back that a dropped replacement took', () => {
    expect(
      parakeetText({
        raw: 'Mittagessen mit Sarah morgen um eins im Fiegelmüller.',
        replacements: [{ from: 'Sarah morgen', to: 'Sarah Novak' }],
        text: 'Mittagessen mit Sarah Novak um eins im Fiegelmüller.',
      }),
    ).toBe('Mittagessen mit Sarah morgen um eins im Fiegelmüller.');
  });

  it('keeps the right ones beside a dropped one, with the punctuation around their spans', () => {
    expect(
      parakeetText({
        raw: 'Coffee with Thomas Kapfmeder, then Anna in the park.',
        replacements: [
          { from: 'Thomas Kapfmeder,', to: 'Thomas Karpfeneder' },
          { from: 'Anna in', to: 'Anna Lee' },
        ],
        text: 'Coffee with Thomas Karpfeneder, then Anna Lee the park.',
      }),
    ).toBe('Coffee with Thomas Karpfeneder, then Anna in the park.');
  });

  it('reads a phrase joined from two readings in order', () => {
    expect(
      parakeetText({
        raw: 'Walk with Anna in Schönbrunn. Anna in the evening.',
        replacements: [
          { from: 'Anna in', to: 'Anna Lee' },
          { from: 'Anna in', to: 'Anna Lee' },
        ],
        text: 'Walk with Anna Lee Schönbrunn. Anna Lee the evening.',
      }),
    ).toBe('Walk with Anna in Schönbrunn. Anna in the evening.');
  });

  it('puts each kept name where its span stands as whole words, in whatever order they are listed', () => {
    expect(
      parakeetText({
        raw: 'Dinner at the Thomas Kapfmederhof with Thomas Kapfmeder and Anna in Grinzing.',
        replacements: [
          { from: 'Anna in', to: 'Anna Lee' },
          { from: 'Thomas Kapfmeder', to: 'Thomas Karpfeneder' },
        ],
        text: 'Dinner at the Thomas Kapfmederhof with Thomas Karpfeneder and Anna Lee Grinzing.',
      }),
    ).toBe('Dinner at the Thomas Kapfmederhof with Thomas Karpfeneder and Anna in Grinzing.');
  });

  it('keeps a name on the place Parakeet put it when its span stands twice', () => {
    expect(
      parakeetText({
        raw: 'Meet Jon and then Jon Bakr with Anna in the park.',
        replacements: [
          { from: 'Anna in', to: 'Anna Lee' },
          { from: 'Jon Bakr', to: 'Jon Baker' },
        ],
        text: 'Meet Jon and then Jon Baker with Anna Lee the park.',
      }),
    ).toBe('Meet Jon and then Jon Baker with Anna in the park.');
    expect(
      parakeetText({
        raw: 'Jon Bakr met Anna in town, then Jon Bakr left.',
        replacements: [
          { from: 'Anna in', to: 'Anna Lee' },
          { from: 'Jon Bakr', to: 'Jon Baker' },
        ],
        text: 'Jon Bakr met Anna Lee town, then Jon Baker left.',
      }),
    ).toBe('Jon Bakr met Anna in town, then Jon Baker left.');
  });

  it('adds only the punctuation a name does not end with, as Parakeet does', () => {
    expect(
      parakeetText({
        raw: 'Jon Bakr met Anna in town with Robert Smit Jr., then Jon Bakr left.',
        replacements: [
          { from: 'Anna in', to: 'Anna Lee' },
          { from: 'Robert Smit Jr.,', to: 'Robert Smith Jr.' },
          { from: 'Jon Bakr', to: 'Jon Baker' },
        ],
        text: 'Jon Bakr met Anna Lee town with Robert Smith Jr., then Jon Baker left.',
      }),
    ).toBe('Jon Bakr met Anna in town with Robert Smith Jr., then Jon Baker left.');
  });

  it('puts back a word a kept name took beside it', () => {
    expect(
      parakeetText({
        raw: 'Mittagessen mit Thomas Kapfmeder um eins.',
        replacements: [{ from: 'Thomas Kapfmeder um', to: 'Thomas Karpfeneder' }],
        text: 'Mittagessen mit Thomas Karpfeneder eins.',
      }),
    ).toBe('Mittagessen mit Thomas Karpfeneder um eins.');
    expect(
      parakeetText({
        raw: 'Dinner at Emily Carters, Werner Straße.',
        replacements: [{ from: 'Emily Carters, Werner', to: 'Emily Carter' }],
        text: 'Dinner at Emily Carter Straße.',
      }),
    ).toBe('Dinner at Emily Carter, Werner Straße.');
  });

  it('is the words before the names when a span is not among them', () => {
    expect(
      parakeetText({
        raw: 'Walk with Anna in Schönbrunn.',
        replacements: [{ from: 'Anna im', to: 'Anna Lee' }],
        text: 'Walk with Anna Lee Schönbrunn.',
      }),
    ).toBe('Walk with Anna in Schönbrunn.');
  });
});
