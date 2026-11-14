import { buildFindTimePrompt } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import { buildFinderLabelPrompt, FINDER_LABEL_SCHEMA } from './finderLabel.ts';

describe('buildFinderLabelPrompt', () => {
  it('is the app’s finder prompt, a length asked for only where one is said', () => {
    const input = {
      phrase: 'an hour tomorrow',
      referenceDate: '2026-11-13',
      timeZone: 'Europe/Vienna',
    };
    const app = buildFindTimePrompt(input).split('\n');
    const teacher = buildFinderLabelPrompt(input).split('\n');
    expect(teacher).toHaveLength(app.length);
    const changed = teacher.filter((line, index) => line !== app[index]);
    expect(changed).toEqual([
      'durationMinutes only when the phrase says how long: "90 min" is 90, "2h" is 120, "half an',
    ]);
    expect(FINDER_LABEL_SCHEMA.required).toEqual([]);
  });
});
