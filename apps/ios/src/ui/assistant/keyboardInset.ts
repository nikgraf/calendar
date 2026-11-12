/**
 * How much of the window the keyboard covers from the bottom, given
 * where its top edge ends up (`screenY` of its end frame): nothing while
 * it is off screen, never more than the window.
 */
export const keyboardOverlap = (keyboardTop: number, windowHeight: number): number =>
  Math.min(Math.max(windowHeight - keyboardTop, 0), windowHeight);
