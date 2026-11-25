import { describe, expect, it } from 'vite-plus/test';
import { type LocationUndo, seenLocation, typedOver, undoTyping } from './locationUndo.ts';

/**
 * What the screen goes through: a keystroke (`text`, over the `at` its
 * render showed) or a render showing a location.
 */
type Event = { readonly at: string; readonly text: string } | { readonly seen: string };

const run = (events: ReadonlyArray<Event>): LocationUndo | undefined =>
  events.reduce<LocationUndo | undefined>(
    (undo, event) =>
      'seen' in event ? seenLocation(undo, event.seen) : typedOver(undo, event.at, event.text),
    undefined,
  );

describe('the location screen undo', () => {
  it('puts back the text from before the typing', () => {
    const undo = run([
      { at: 'Café', text: 'Café P' },
      { seen: 'Café P' },
      { at: 'Café P', text: 'Café Pr' },
      { seen: 'Café Pr' },
    ]);
    expect(undoTyping(undo, 'Café Pr')).toBe('Café');
  });

  it('puts nothing back with nothing typed, or typed back as it was', () => {
    expect(undoTyping(run([{ seen: 'Café' }]), 'Café')).toBeUndefined();
    const undo = run([
      { at: 'Café', text: 'Caf' },
      { seen: 'Caf' },
      { at: 'Caf', text: 'Café' },
      { seen: 'Café' },
    ]);
    expect(undoTyping(undo, 'Café')).toBeUndefined();
  });

  it('leaves a turn that landed after the last keystroke', () => {
    // Review (Opus round 2): Cancel put "Café" back over the turn's place.
    const undo = run([{ at: 'Café', text: 'Café P' }, { seen: 'Café P' }, { seen: 'Plachutta' }]);
    expect(undoTyping(undo, 'Plachutta')).toBeUndefined();
  });

  it('keeps a turn that landed between two keystrokes', () => {
    // Review (Codex round 1): open on A, type B, the turn gives C, type D,
    // Cancel — A came back and C was lost.
    const undo = run([
      { at: 'A', text: 'B' },
      { seen: 'B' },
      { seen: 'C' },
      { at: 'C', text: 'D' },
      { seen: 'D' },
    ]);
    expect(undoTyping(undo, 'D')).toBe('C');
  });

  it('takes two keystrokes before a render as the screen’s own', () => {
    // Review (Codex round 2): C and D arrive over the same render of B;
    // Cancel put B back, keeping cancelled typing.
    const undo = run([
      { at: 'A', text: 'B' },
      { seen: 'B' },
      { at: 'B', text: 'C' },
      { at: 'B', text: 'D' },
      { seen: 'D' },
    ]);
    expect(undoTyping(undo, 'D')).toBe('A');
  });
});
