import type { LanguageModel, TextRecognizer } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyCaptureEvent,
  CAPTURE_MODEL_UNAVAILABLE,
  markCaptureRowAdded,
  runCapture,
  type CaptureEvent,
  type CaptureState,
} from './captureModel.ts';

const TIME_ZONE = 'Europe/Vienna';

const modelAnswering = (events: ReadonlyArray<Record<string, unknown>>): LanguageModel => ({
  generateJson: async () => ({ events }),
  status: async () => 'ready',
});

const recognizer: TextRecognizer = { recognizeText: async () => 'Poster text' };

/** A date well ahead of any "today", so nothing is read as last year. */
const ahead = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 400 + days);
  return date.toISOString().slice(0, 10);
};

const eventsOf = async (model: LanguageModel, source = { kind: 'text', text: 'mail' } as const) => {
  const events: Array<CaptureEvent> = [];
  await runCapture({ model, recognizer, timeZone: TIME_ZONE }, source, (event) =>
    events.push(event),
  );
  return events;
};

// `useCaptureModel.start` fires `onSettled` on the terminal event — the
// moment a shared image may be deleted — so every path below must end in
// exactly one, the unavailable model (no OCR ever ran) included.
describe('runCapture', () => {
  it('reports the phases, then a review for several events', async () => {
    const events = await eventsOf(
      modelAnswering([
        { date: ahead(1), title: 'Standup' },
        { date: ahead(2), startTime: '10:00', title: 'Review' },
      ]),
    );
    expect(events.map((event) => event.kind)).toEqual(['phase', 'review']);
    expect(events[1]).toMatchObject({ kind: 'review', truncated: false });
    expect(events[1]?.kind === 'review' && events[1].drafts.map((d) => d.title)).toEqual([
      'Standup',
      'Review',
    ]);
  });

  it('hands a single event straight to the caller', async () => {
    const events = await eventsOf(modelAnswering([{ date: ahead(1), title: 'Dinner' }]), {
      image: { base64: 'x', kind: 'base64' },
      kind: 'image',
    } as never);
    expect(events.map((event) => event.kind)).toEqual(['phase', 'phase', 'single']);
    expect(events.at(-1)).toMatchObject({ kind: 'single', prefill: { title: 'Dinner' } });
  });

  it('turns a rejection and an unavailable model into errors', async () => {
    expect(await eventsOf(modelAnswering([]))).toEqual([
      { kind: 'phase', phase: 'extracting' },
      { kind: 'error', message: 'No dated events were found.' },
    ]);
    const unavailable: LanguageModel = {
      generateJson: async () => ({}),
      status: async () => 'unavailable',
    };
    expect(await eventsOf(unavailable)).toEqual([
      { kind: 'error', message: CAPTURE_MODEL_UNAVAILABLE },
    ]);
  });
});

describe('capture state', () => {
  it('builds rows from a review and marks one added', () => {
    const review = applyCaptureEvent({
      drafts: [
        { date: '2030-01-01', endTime: '01:00', isAllDay: true, startTime: '00:00', title: 'A' },
        { date: '2030-01-02', endTime: '01:00', isAllDay: true, startTime: '00:00', title: 'B' },
      ],
      kind: 'review',
      truncated: true,
    });
    expect(review).toMatchObject({ kind: 'review', truncated: true });
    const added = markCaptureRowAdded(review, 'capture-1');
    expect(added.kind === 'review' && added.rows.map((row) => row.status)).toEqual([
      'open',
      'added',
    ]);
    expect(markCaptureRowAdded(added, 'nope')).toEqual(added);
  });

  it('maps the other events and leaves non-review states alone', () => {
    expect(applyCaptureEvent({ kind: 'phase', phase: 'reading' })).toEqual({ kind: 'reading' });
    expect(applyCaptureEvent({ kind: 'error', message: 'x' })).toEqual({
      kind: 'error',
      message: 'x',
    });
    const single: CaptureState = applyCaptureEvent({
      kind: 'single',
      prefill: {
        date: '2030-01-01',
        endTime: '01:00',
        isAllDay: true,
        startTime: '00:00',
        title: 'A',
      },
    });
    expect(single).toEqual({ kind: 'idle' });
    expect(markCaptureRowAdded(single, 'capture-0')).toEqual(single);
  });
});
