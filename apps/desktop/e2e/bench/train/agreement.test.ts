import { describe, expect, it } from 'vite-plus/test';
import { buildTunedFinderPrompt } from '@calendar/ai';
import { buildTunedPrompt, buildTunedRefinePrompt } from '../tuned.ts';
import { promptDates, rowAgreement, totalsOf } from './agreement.ts';

// A Thursday; the tests only ever compare against it.
const TODAY = '2026-11-12';
const first = buildTunedPrompt({ phrase: 'haircut on the 23rd', referenceDate: TODAY });
const later = buildTunedRefinePrompt({
  earlier: ['wedding March 14'],
  referenceDate: TODAY,
  state: { date: '2027-03-14', kind: 'event', title: 'Wedding' },
  utterance: 'actually the 15th',
});

describe('promptDates', () => {
  it('reads the today of a prompt and the day of the draft it shows', () => {
    expect(promptDates(first)).toEqual({ referenceDate: TODAY });
    expect(promptDates(later)).toMatchObject({ draftDate: '2027-03-14', referenceDate: TODAY });
    expect(promptDates('Phrase: haircut')).toBeUndefined();
  });
});

describe('rowAgreement', () => {
  it('holds a day written as said and the same day written whole to agree', () => {
    const row = rowAgreement(
      first,
      { date: '23', kind: 'event', title: 'Haircut' },
      { date: '2026-11-23', kind: 'event', title: 'Haircut' },
    );
    expect(row).toMatchObject({
      parts: { date: true, kind: true, title: true },
      same: false,
      sameWorked: true,
      span: 'listed',
      writtenAsSaid: true,
    });
  });

  it('works a later turn’s day out beside the draft’s, and says which parts differ', () => {
    const row = rowAgreement(
      later,
      { date: '15', kind: 'event', title: 'Wedding' },
      { date: '2026-11-15', kind: 'event', location: 'Porto', title: 'Wedding' },
    );
    expect(row).toMatchObject({
      parts: { date: false, kind: true, location: false, title: true },
      sameWorked: false,
      span: 'beyond',
    });
  });

  it('works times said as amounts out from the draft’s, as the app does', () => {
    const call = buildTunedRefinePrompt({
      earlier: ['call at 5'],
      referenceDate: TODAY,
      state: { date: TODAY, endTime: '18:00', kind: 'event', startTime: '17:00', title: 'Call' },
      utterance: 'half an hour later',
    });
    const agreed = rowAgreement(
      call,
      { endTime: '+30m', kind: 'event', startTime: '+30m', title: 'Call' },
      { endTime: '18:30', kind: 'event', startTime: '17:30', title: 'Call' },
    );
    expect(agreed?.sameWorked).toBe(true);
    expect(agreed?.parts).toEqual({ endTime: true, kind: true, startTime: true, title: true });
  });

  it('holds a length said apart from a clock time that only reads the same', () => {
    // From 09:00, "20h" ends at 05:00 the next day; "05:00" written as a clock is an hour (no night).
    const shift = buildTunedPrompt({ phrase: 'shift from 9 for 20 hours', referenceDate: TODAY });
    const row = rowAgreement(
      shift,
      { endTime: '20h', kind: 'event', startTime: '09:00', title: 'Shift' },
      { endTime: '05:00', kind: 'event', startTime: '09:00', title: 'Shift' },
    );
    expect(row?.sameWorked).toBe(false);
    expect(row?.parts).toMatchObject({ endDate: false, endTime: false });
    const same = rowAgreement(
      shift,
      { endTime: '20h', kind: 'event', startTime: '09:00', title: 'Shift' },
      { endTime: '1200m', kind: 'event', startTime: '09:00', title: 'Shift' },
    );
    expect(same?.sameWorked).toBe(true);
  });

  it('counts an answer that is no draft as agreeing on nothing', () => {
    const row = rowAgreement(first, { date: '2026-11-13', title: 'Haircut' }, 'no');
    expect(row).toMatchObject({
      parts: { date: false, title: false },
      same: false,
      sameWorked: false,
      writtenAsSaid: false,
    });
    expect(rowAgreement('no prompt', {}, {})).toBeUndefined();
  });

  it('holds a finder sentence’s answer as written, field by field', () => {
    const prompt = buildTunedFinderPrompt({ phrase: 'an hour tomorrow', referenceDate: TODAY });
    const row = rowAgreement(
      prompt,
      { durationMinutes: 60, windowEndDate: '2026-11-13', windowStartDate: '2026-11-13' },
      { durationMinutes: 90, windowEndDate: '2026-11-13', windowStartDate: '2026-11-13' },
    );
    expect(row).toMatchObject({
      parts: { durationMinutes: false, windowEndDate: true, windowStartDate: true },
      same: false,
      sameWorked: false,
      writtenAsSaid: false,
    });
  });

  it('does not mind the order an answer’s parts come in', () => {
    const row = rowAgreement(
      first,
      { date: '2026-11-13', repeat: { byDay: ['MO'], freq: 'weekly' }, title: 'Haircut' },
      // As a model writes it: the tuned arm's order, not the alphabet's.
      JSON.parse(
        '{"title":"Haircut","date":"2026-11-13","repeat":{"freq":"weekly","byDay":["MO"]}}',
      ),
    );
    expect(row).toMatchObject({ same: true, sameWorked: true });
  });
});

describe('totalsOf', () => {
  it('counts the rows, each part, and the date by where the day to learn lies', () => {
    const rows = [
      rowAgreement(first, { date: '23', title: 'Haircut' }, { date: '23', title: 'Haircut' }),
      rowAgreement(
        first,
        { date: '03-14', title: 'Party' },
        { date: '2026-03-14', title: 'Party' },
      ),
      rowAgreement(first, { title: 'Call' }, { title: 'Call mum' }),
    ].flatMap((row) => row ?? []);
    expect(totalsOf(rows)).toEqual({
      byPart: { date: { agree: 1, rows: 2 }, title: { agree: 2, rows: 3 } },
      bySpan: {
        beyond: { agree: 0, rows: 1 },
        listed: { agree: 1, rows: 1 },
        none: { agree: 1, rows: 1 },
        past: { agree: 0, rows: 0 },
      },
      rows: 3,
      same: 1,
      sameWorked: 1,
      writtenAsSaid: { rows: 2, sameWorked: 1 },
    });
  });
});
