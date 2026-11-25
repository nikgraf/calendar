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
 * A keystroke writes `text` over `location`. What Cancel puts back is the
 * text from before the screen's typing, taken again when something else
 * changed the location since the screen's last write: that change stays.
 */
export const typedOver = (
  undo: LocationUndo | undefined,
  location: string,
  text: string,
): LocationUndo => ({
  before: undo !== undefined && undo.wrote === location ? undo.before : location,
  wrote: text,
});

/**
 * The text Cancel puts back, if any: only while the location still reads
 * the screen's last write, and only when that changed it.
 */
export const undoTyping = (undo: LocationUndo | undefined, location: string): string | undefined =>
  undo !== undefined && location === undo.wrote && undo.before !== location
    ? undo.before
    : undefined;
