import { describe, expect, it } from 'vite-plus/test';
import { makeFixtureLanguageModel } from './fixtureModel.ts';
import { tunedReader } from './phraseReader.ts';
import type { TurnDraft } from './tunedResult.ts';

// A Sunday; `+N` counts from it.
const TODAY = '2026-09-20';
const ZONE = 'Europe/Vienna';
const reader = tunedReader(makeFixtureLanguageModel());

const dentist: TurnDraft = {
  guests: ['anna@example.com'],
  kind: 'event',
  notes: 'bring the card',
  prefill: {
    date: '2026-09-22',
    endTime: '11:00',
    isAllDay: false,
    location: 'Room 4',
    startTime: '10:00',
    title: 'Dentist',
  },
  reminders: [30],
};

const change = (utterance: string, draft: TurnDraft = dentist) =>
  reader.change({ draft, referenceDate: TODAY, said: ['Dentist'], timeZone: ZONE, utterance });

describe('the fixture model on the tuned prompt', () => {
  it('reads a first phrase in its grammar, with the people, notification and note it names', async () => {
    await expect(
      reader.first({
        phrase: 'Lunch | +2 | 13:00-14:00 | Figlmüller | invite Anna Lee and Tom',
        referenceDate: TODAY,
        timeZone: ZONE,
      }),
    ).resolves.toEqual({
      invite: ['Anna Lee', 'Tom'],
      kind: 'parsed',
      prefill: {
        date: '2026-09-22',
        endTime: '14:00',
        isAllDay: false,
        location: 'Figlmüller',
        startTime: '13:00',
        title: 'Lunch',
      },
    });
    await expect(
      reader.first({
        phrase: 'Dentist | +2 | 10:00-11:00 | | remind 30, note: bring the card, and the form',
        referenceDate: TODAY,
        timeZone: ZONE,
      }),
    ).resolves.toMatchObject({
      notes: { kind: 'add', text: 'bring the card, and the form' },
      reminders: { add: [30] },
    });
  });

  it('reads a day written out', async () => {
    await expect(
      reader.first({
        phrase: 'Trip | 2026-12-04 | 08:00-09:00',
        referenceDate: TODAY,
        timeZone: ZONE,
      }),
    ).resolves.toMatchObject({ prefill: { date: '2026-12-04', startTime: '08:00' } });
  });

  it('makes a to-do from "todo:", and a title on the day from any other phrase', async () => {
    await expect(
      reader.first({ phrase: 'todo: Call the bank', referenceDate: TODAY, timeZone: ZONE }),
    ).resolves.toEqual({ kind: 'task', prefill: { date: TODAY, title: 'Call the bank' } });
    await expect(
      reader.first({
        fallbackDate: '2026-09-25',
        phrase: 'Coffee with Sam',
        referenceDate: TODAY,
        timeZone: ZONE,
      }),
    ).resolves.toMatchObject({
      prefill: { date: '2026-09-25', isAllDay: true, title: 'Coffee with Sam' },
    });
  });

  it('keeps a later turn to what it names, the rest of the draft as it was', async () => {
    await expect(change('| | 16:00-17:00')).resolves.toEqual({
      kind: 'parsed',
      prefill: { ...dentist.prefill, endTime: '17:00', startTime: '16:00' },
    });
    await expect(change('Dentist (moved) | | 18:00-19:00')).resolves.toMatchObject({
      prefill: { location: 'Room 4', startTime: '18:00', title: 'Dentist (moved)' },
    });
    // Nothing named: the draft as it was, its day not said.
    const unchanged = await change('something else');
    expect(unchanged).toEqual({ kind: 'parsed', prefill: dentist.prefill });
    expect(unchanged).not.toHaveProperty('saidDay');
  });

  it('adds a notification and a note, and takes people on and off', async () => {
    await expect(change('remind 60')).resolves.toMatchObject({
      reminders: { add: [60], clear: false, remove: [] },
    });
    await expect(change('note: ask about the fee')).resolves.toMatchObject({
      notes: { text: 'bring the card\nask about the fee' },
    });
    await expect(change('invite Tom and Bo')).resolves.toMatchObject({ invite: ['Tom', 'Bo'] });
    await expect(change('remove Anna')).resolves.toMatchObject({ uninvite: ['Anna'] });
  });

  it('dates, repeats and stops repeating; an echoed rule comes back the same', async () => {
    await expect(change('due +0')).resolves.toMatchObject({
      prefill: { date: TODAY },
      saidDay: true,
    });
    const weekly = await change('repeat weekly');
    expect(weekly).toMatchObject({ prefill: { recurrence: { freq: 'weekly' } } });
    const daily: TurnDraft = {
      guests: [],
      kind: 'event',
      prefill: {
        date: '2026-09-22',
        endTime: '09:30',
        isAllDay: false,
        recurrence: { count: 14, freq: 'daily' },
        startTime: '09:00',
        title: 'Daily sync',
      },
    };
    await expect(change('| | 09:30-10:00', daily)).resolves.toMatchObject({
      prefill: { recurrence: { count: 14, freq: 'daily' }, startTime: '09:30' },
    });
    await expect(change('repeat none', daily)).resolves.not.toHaveProperty('prefill.recurrence');
  });
});
