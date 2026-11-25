import { describe, expect, it } from 'vite-plus/test';
import { type LocationUndo, typedOver, undoTyping } from './locationUndo.ts';

/** Keystrokes typed one after another, each over what the editor then holds. */
const typeAll = (
  steps: ReadonlyArray<{ location: string; text: string }>,
): LocationUndo | undefined =>
  steps.reduce<LocationUndo | undefined>(
    (undo, { location, text }) => typedOver(undo, location, text),
    undefined,
  );

describe('the location screen undo', () => {
  it('puts back the text from before the typing', () => {
    const undo = typeAll([
      { location: 'Café', text: 'Café P' },
      { location: 'Café P', text: 'Café Pr' },
    ]);
    expect(undoTyping(undo, 'Café Pr')).toBe('Café');
  });

  it('puts nothing back with nothing typed, or typed back as it was', () => {
    expect(undoTyping(undefined, 'Café')).toBeUndefined();
    const undo = typeAll([
      { location: 'Café', text: 'Caf' },
      { location: 'Caf', text: 'Café' },
    ]);
    expect(undoTyping(undo, 'Café')).toBeUndefined();
  });

  it('leaves a turn that landed after the last keystroke', () => {
    // Review (Opus round 2): Cancel put "Café" back over the turn's place.
    const undo = typeAll([{ location: 'Café', text: 'Café P' }]);
    expect(undoTyping(undo, 'Plachutta')).toBeUndefined();
  });

  it('keeps a turn that landed between two keystrokes', () => {
    // Review (Codex round 1): open on A, type B, the turn gives C, type D,
    // Cancel — A came back and C was lost.
    const undo = typeAll([
      { location: 'A', text: 'B' },
      { location: 'C', text: 'D' },
    ]);
    expect(undoTyping(undo, 'D')).toBe('C');
  });
});
