import { describe, expect, it } from 'vite-plus/test';
import { createEndpointer, levelOf, type SpeechEvent } from './endpointer.ts';

const FRAME_MS = 50;

/** Syllables and the gaps between them. */
const speaking = (frame: number) => (frame % 4 === 3 ? -42 : -22);

/** Stretches of a constant level (or a level per frame), as the adapters feed them. */
type Stretch = readonly [level: number | ((frame: number) => number), ms: number];

/** Feeds the stretches frame by frame; returns each event with the time it fired. */
const run = (stretches: ReadonlyArray<Stretch>) => {
  const endpointer = createEndpointer();
  const events: Array<{ readonly at: number; readonly event: SpeechEvent }> = [];
  let at = 0;
  for (const [level, ms] of stretches) {
    for (let frame = 0; frame < ms / FRAME_MS; frame += 1) {
      const event = endpointer.push(typeof level === 'number' ? level : level(frame), at);
      if (event) {
        events.push({ at, event });
      }
      at += FRAME_MS;
    }
  }
  return { endpointer, events };
};

describe('createEndpointer', () => {
  it('ends a phrase after the pause that follows it', () => {
    const { endpointer, events } = run([
      [-60, 1000],
      [-25, 1000],
      [-60, 2500],
    ]);
    expect(events.map((entry) => entry.event)).toEqual(['start', 'end']);
    const [start, end] = events;
    // Confirmed after a quarter second of voice; ended 1.3 s after the last of it.
    expect(start?.at).toBeGreaterThanOrEqual(1200);
    expect(start?.at).toBeLessThan(1400);
    expect(end?.at).toBeGreaterThanOrEqual(1950 + 1300);
    expect(end?.at).toBeLessThan(1950 + 1300 + 2 * FRAME_MS);
    expect(endpointer.heard()).toBe(true);
  });

  it('holds a phrase open through pauses shorter than the end', () => {
    const { events } = run([
      [-60, 500],
      [-25, 800],
      [-60, 900],
      [-25, 800],
      [-60, 2000],
    ]);
    expect(events.map((entry) => entry.event)).toEqual(['start', 'end']);
    expect(events[1]?.at).toBeGreaterThan(500 + 800 + 900 + 800);
  });

  it('never counts a cough or a click as speech', () => {
    const { endpointer, events } = run([
      [-60, 1000],
      [-20, 100],
      [-60, 2000],
      [-20, 150],
      [-60, 3000],
    ]);
    expect(events).toEqual([]);
    expect(endpointer.heard()).toBe(false);
  });

  it('measures speech against a noisy room, not a fixed level', () => {
    const { events } = run([
      [-42, 1500],
      [-15, 1000],
      [-42, 2000],
    ]);
    expect(events.map((entry) => entry.event)).toEqual(['start', 'end']);
  });

  it('a noisy room alone is not speech', () => {
    expect(run([[-42, 30_000]]).events).toEqual([]);
  });

  it('says nothing about silence, digital silence included', () => {
    const { endpointer, events } = run([
      [Number.NEGATIVE_INFINITY, 500],
      [-160, 500],
      [-60, 30_000],
    ]);
    expect(events).toEqual([]);
    expect(endpointer.heard()).toBe(false);
  });

  it('hears speech that begins with the recording', () => {
    // From the first frame on: no quiet room to measure first.
    const { events } = run([
      [speaking, 2000],
      [-45, 2000],
    ]);
    expect(events.map((entry) => entry.event)).toEqual(['start', 'end']);
  });

  it('hears a microphone that gates its quiet to digital silence', () => {
    // Speaking from the first frame, zeros between the words and after them.
    const { events } = run([
      [-25, 600],
      [Number.NEGATIVE_INFINITY, 300],
      [-25, 600],
      [Number.NEGATIVE_INFINITY, 2000],
    ]);
    expect(events.map((entry) => entry.event)).toEqual(['start', 'end']);
  });

  it('lets a noise that starts mid-listening become the floor', () => {
    // A fan comes on: it may pass for speech at first, but it ends.
    const { events } = run([
      [-60, 1000],
      [-38, 15_000],
    ]);
    expect(events.at(-1)?.event).toBe('end');
    expect(events.at(-1)?.at).toBeLessThan(1000 + 8000);
  });

  it('reports nothing after the end', () => {
    const endpointer = createEndpointer();
    let at = 0;
    const feed = (level: number, ms: number) => {
      const events: Array<SpeechEvent> = [];
      for (let frame = 0; frame < ms / FRAME_MS; frame += 1) {
        const event = endpointer.push(level, at);
        if (event) {
          events.push(event);
        }
        at += FRAME_MS;
      }
      return events;
    };
    expect([...feed(-60, 500), ...feed(-25, 1000), ...feed(-60, 2000)]).toEqual(['start', 'end']);
    expect([...feed(-25, 1000), ...feed(-60, 2000)]).toEqual([]);
  });
});

describe('levelOf', () => {
  it('reads a full-scale square wave as 0 dBFS', () => {
    expect(levelOf([1, -1, 1, -1])).toBeCloseTo(0);
  });

  it('reads a tenth of full scale as -20 dBFS', () => {
    expect(levelOf(new Float32Array(160).fill(0.1))).toBeCloseTo(-20, 3);
  });

  it('reads digital silence and an empty block as -Infinity', () => {
    expect(levelOf(new Float32Array(128))).toBe(Number.NEGATIVE_INFINITY);
    expect(levelOf([])).toBe(Number.NEGATIVE_INFINITY);
  });
});
