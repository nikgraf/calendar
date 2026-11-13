import { LESSON_CREATE_CHANGE, LESSON_CREATE_PHRASE, Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { LESSON_DEMO_ONLY, lessonDemoModel } from './lessonDemo.ts';
import { tunedReader } from './phraseReader.ts';
import { buildTunedPrompt } from './tuned.ts';

const reader = tunedReader(lessonDemoModel);
const timeZone = 'Europe/Vienna';
// Any day: the answer counts "tomorrow" from it.
const today = Temporal.Now.plainDateISO(timeZone).toString();
const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 }).toString();

describe('the Create lesson’s demo', () => {
  it('answers the lesson’s phrase as v1 did, tomorrow from any day', async () => {
    for (const referenceDate of [today, '2026-12-31', '2028-02-28']) {
      const result = await reader.first({ phrase: LESSON_CREATE_PHRASE, referenceDate, timeZone });
      expect(result).toMatchObject({
        kind: 'parsed',
        prefill: {
          date: Temporal.PlainDate.from(referenceDate).add({ days: 1 }).toString(),
          endTime: '13:30',
          isAllDay: false,
          location: 'Mercato',
          startTime: '12:30',
          title: 'Lunch with Sam',
        },
      });
    }
  });

  it('moves the lunch to one for the change, the rest of the draft as it was', async () => {
    const first = await reader.first({
      phrase: LESSON_CREATE_PHRASE,
      referenceDate: today,
      timeZone,
    });
    if (first.kind !== 'parsed') {
      throw new Error('the demo did not answer its phrase');
    }
    const changed = await reader.change({
      draft: { guests: [], kind: 'event', prefill: first.prefill, reminders: [10] },
      referenceDate: today,
      said: [LESSON_CREATE_PHRASE],
      timeZone,
      utterance: LESSON_CREATE_CHANGE,
    });
    expect(changed).toMatchObject({
      kind: 'parsed',
      prefill: {
        date: tomorrow,
        endTime: '14:00',
        location: 'Mercato',
        startTime: '13:00',
        title: 'Lunch with Sam',
      },
    });
  });

  it('reads nothing else: other words are refused', async () => {
    expect(
      await reader.first({ phrase: 'Dinner with Anna at 7', referenceDate: today, timeZone }),
    ).toMatchObject({ kind: 'rejected' });
    await expect(
      lessonDemoModel.generateJson({
        jsonSchema: undefined,
        prompt: buildTunedPrompt({ phrase: 'Dinner with Anna at 7', referenceDate: today }),
      }),
    ).rejects.toThrow(LESSON_DEMO_ONLY);
  });
});
