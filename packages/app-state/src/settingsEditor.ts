/** Structural equality of two plain JSON-like values, object keys in any order. */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        key in b &&
        sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
};

/**
 * What a settings editor shows (`useSettingsEditor`): the stored value,
 * or the last value sent while saves are in flight or the stored one has
 * not caught up with it. `landed`: every save is back and the stored value
 * matches, so the editor drops what it sent — from then on a change
 * another editor makes to the same key shows. Not before every save is
 * back: a change undone at once (tick, untick) matches the stored value
 * before the first save's re-read brings the ticked one in.
 */
export const settingsEditorView = <A>(
  sent: A | null,
  stored: A | null,
  inFlight: number,
): { readonly current: A | null; readonly landed: boolean } => {
  const landed = sent !== null && stored !== null && inFlight === 0 && sameValue(sent, stored);
  return { current: landed ? stored : (sent ?? stored), landed };
};
