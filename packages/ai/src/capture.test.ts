import { describe, expect, it } from 'vitest';
import {
  buildCapturePrompt,
  CAPTURE_JSON_SCHEMA,
  CAPTURE_TEXT_MARKER,
  MAX_CAPTURE_EVENTS,
  MAX_CAPTURE_TEXT_CHARS,
  normalizeCapture,
  prepareCaptureText,
  resolveUnstatedYear,
} from './capture.ts';

const CONTEXT = { referenceDate: '2026-09-20', sourceText: '', timeZone: 'Europe/Vienna' };
const at = (referenceDate: string, sourceText = '') => ({ referenceDate, sourceText });

describe('prepareCaptureText', () => {
  it('normalises newlines and blank runs', () => {
    const { text, truncated } = prepareCaptureText(
      'Hi\r\n\r\n\r\n\r\nTeam   meeting\ttomorrow \r\n',
    );
    expect(text).toBe('Hi\n\nTeam meeting tomorrow');
    expect(truncated).toBe(false);
  });

  it('cuts a quoted reply but keeps a thread that starts quoted', () => {
    const mail = ['Moved to Friday 10:00.', '', 'On Mon, Sep 14, Anna wrote:', '> Thursday 09:00?'];
    expect(prepareCaptureText(mail.join('\n')).text).toBe('Moved to Friday 10:00.');
    // A forward: the first content line is already the marker, so nothing
    // precedes it and the quoted mail is the whole message.
    const forward = ['> Dinner Saturday 19:00', '> at Figlmüller'].join('\n');
    expect(prepareCaptureText(forward).text).toBe(forward);
  });

  it('recognises Outlook and German reply separators', () => {
    expect(prepareCaptureText('New time.\n-----Original Message-----\nOld').text).toBe('New time.');
    expect(prepareCaptureText('Neu.\nAm 14.09.2026 schrieb Anna:\nAlt').text).toBe('Neu.');
    expect(prepareCaptureText('Top.\n________________________________\nOld').text).toBe('Top.');
  });

  it('clips tokens longer than a URL has any right to be', () => {
    const url = `https://example.com/${'x'.repeat(200)}`;
    const { text } = prepareCaptureText(`Tickets: ${url} see you`);
    expect(text.length).toBeLessThan(90);
    expect(text.endsWith('… see you')).toBe(true);
  });

  it('caps at a line boundary and says so', () => {
    const line = `${'word '.repeat(19)}end`;
    const raw = Array.from({ length: 100 }, () => line).join('\n');
    const { text, truncated } = prepareCaptureText(raw);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_CAPTURE_TEXT_CHARS);
    expect(text.endsWith('end')).toBe(true);
  });
});

describe('resolveUnstatedYear', () => {
  it('keeps a date the text dates itself', () => {
    expect(resolveUnstatedYear('2026-03-14', at('2026-09-20', 'Pi day 2026'))).toBe('2026-03-14');
  });

  it('keeps a recent past date (the mail is a week old)', () => {
    expect(resolveUnstatedYear('2026-09-01', at('2026-09-20'))).toBe('2026-09-01');
  });

  it('moves a date well in the past to the coming year', () => {
    expect(resolveUnstatedYear('2026-03-14', at('2026-09-20'))).toBe('2027-03-14');
  });

  it('constrains Feb 29 when the next year has none', () => {
    expect(resolveUnstatedYear('2028-02-29', at('2028-12-01'))).toBe('2029-02-28');
  });
});

describe('normalizeCapture', () => {
  it('validates each item like quick-add and sorts by when', () => {
    const drafts = normalizeCapture(
      {
        events: [
          { date: '2026-09-22', startTime: '14:00', title: 'Review' },
          { date: '2026-09-21', isAllDay: true, title: 'Offsite' },
          { date: '2026-09-22', location: 'Room 4', startTime: '09:00', title: 'Standup' },
        ],
      },
      CONTEXT,
    );
    expect(drafts.map((draft) => `${draft.date} ${draft.startTime} ${draft.title}`)).toEqual([
      '2026-09-21 00:00 Offsite',
      '2026-09-22 09:00 Standup',
      '2026-09-22 14:00 Review',
    ]);
    expect(drafts[1]).toMatchObject({ endTime: '10:00', isAllDay: false, location: 'Room 4' });
  });

  it('drops undated items instead of placing them on today', () => {
    const drafts = normalizeCapture(
      { events: [{ title: 'Someday' }, { date: 'next week', title: 'Vague' }] },
      CONTEXT,
    );
    expect(drafts).toEqual([]);
  });

  it('drops duplicates and tolerates junk', () => {
    const item = { date: '2026-09-22', startTime: '09:00', title: 'Standup' };
    const drafts = normalizeCapture(
      {
        events: [item, { ...item, title: 'standup' }, null as never, 'x' as never, { title: ' ' }],
      },
      CONTEXT,
    );
    expect(drafts).toHaveLength(1);
    expect(normalizeCapture({} as never, CONTEXT)).toEqual([]);
  });

  it('caps the number of events', () => {
    const events = Array.from({ length: MAX_CAPTURE_EVENTS + 3 }, (_, index) => ({
      date: '2026-10-01',
      title: `Talk ${String(index).padStart(2, '0')}`,
    }));
    expect(normalizeCapture({ events }, CONTEXT)).toHaveLength(MAX_CAPTURE_EVENTS);
  });

  it('applies the unstated-year rule per item', () => {
    const drafts = normalizeCapture(
      { events: [{ date: '2026-01-10', title: 'Kickoff' }] },
      { ...CONTEXT, sourceText: 'Kickoff on Jan 10' },
    );
    expect(drafts[0]?.date).toBe('2027-01-10');
  });
});

describe('buildCapturePrompt and schema', () => {
  it('ends with the marker and the text, and names today', () => {
    const prompt = buildCapturePrompt({ ...CONTEXT, text: 'Dinner Friday' });
    expect(prompt).toContain('Today is 2026-09-20 in time zone Europe/Vienna');
    expect(prompt.endsWith(`${CAPTURE_TEXT_MARKER}Dinner Friday`)).toBe(true);
  });

  it('asks for an array of dated items without a repeat', () => {
    const item = CAPTURE_JSON_SCHEMA.properties.events.items;
    expect(item.required).toEqual(['date', 'title']);
    expect(Object.keys(item.properties)).not.toContain('recurrence');
    expect(CAPTURE_JSON_SCHEMA.properties.events.maxItems).toBe(MAX_CAPTURE_EVENTS);
  });
});
