/**
 * What the location screen's typing changed, for its Cancel: the text
 * from before the typing, and the last text the screen wrote. The screen
 * writes each keystroke to the editor, and a turn already in flight can
 * still land in between: the location then is no longer the screen's.
 */
export interface LocationUndo {
  readonly before: string;
  readonly wrote: string;
}

/**
 * A keystroke writes `text` over `location`. The text from before the
 * typing is kept from the first keystroke on. Nothing here asks whether
 * `location` is still the screen's: two keystrokes can arrive before a
 * render, both over the same `location`, and the second would read the
 * first's write as someone else's. `seenLocation` answers that instead.
 */
export const typedOver = (
  undo: LocationUndo | undefined,
  location: string,
  text: string,
): LocationUndo => ({ before: undo?.before ?? location, wrote: text });

/**
 * The location as a render shows it. Not the screen's last write: a turn
 * changed it, and that change is what Cancel now puts back, so it stays.
 */
export const seenLocation = (
  undo: LocationUndo | undefined,
  location: string,
): LocationUndo | undefined =>
  undo === undefined || undo.wrote === location ? undo : { before: location, wrote: location };

/**
 * The text Cancel puts back, if any: only while the location still reads
 * the screen's last write, and only when that changed it.
 */
export const undoTyping = (undo: LocationUndo | undefined, location: string): string | undefined =>
  undo !== undefined && location === undo.wrote && undo.before !== location
    ? undo.before
    : undefined;
