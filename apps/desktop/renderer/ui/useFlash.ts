import {
  type FlashField,
  type StepField,
  TURN_FLASH_FADE_MS,
  TURN_FLASH_HOLD_MS,
} from '@calendar/app-state';
import { createContext, type RefObject, useContext, useEffect, useRef } from 'react';

/** How long a lasting mark takes to come up. */
const MARK_IN_MS = 160;

/**
 * A tint behind an element something just changed: its background takes
 * the `highlight` token once per `key`, nothing while it is null.
 * Fleeting (a search turn's chip), it holds for `TURN_FLASH_HOLD_MS` and
 * eases back to its own over `TURN_FLASH_FADE_MS`; `lasting` (the fields
 * the editor's step on show changed), it comes up and stays until the key
 * changes, and the element carries `data-marked` meanwhile. A color
 * change, not movement, so reduced motion keeps it. The next key (or the
 * element leaving) cancels one that is up, so its own color is read
 * clean.
 */
export const useFlash = <T extends HTMLElement>(
  key: string | null,
  lasting = false,
): RefObject<T | null> => {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (key === null || element === null) {
      return undefined;
    }
    const highlight = getComputedStyle(document.documentElement)
      .getPropertyValue('--highlight')
      .trim();
    const own = getComputedStyle(element).backgroundColor;
    const duration = TURN_FLASH_HOLD_MS + TURN_FLASH_FADE_MS;
    const animation = lasting
      ? element.animate([{ backgroundColor: own }, { backgroundColor: highlight }], {
          duration: MARK_IN_MS,
          easing: 'ease-out',
          fill: 'forwards',
        })
      : element.animate(
          [
            { backgroundColor: highlight },
            // Held, then the fade: the easing names the segment that follows.
            {
              backgroundColor: highlight,
              easing: 'ease-in-out',
              offset: TURN_FLASH_HOLD_MS / duration,
            },
            { backgroundColor: own },
          ],
          { duration },
        );
    // A lasting mark is a state, not a moment: the element says so.
    if (lasting) {
      element.dataset['marked'] = '';
    }
    return () => {
      animation.cancel();
      delete element.dataset['marked'];
    };
  }, [key, lasting]);
  return ref;
};

/**
 * What the editor's form marks: the fields the step on show changed
 * (`useThreadEditor().marks`), kept until another step is shown.
 */
export interface FieldMarks {
  readonly fields: ReadonlySet<StepField>;
  readonly key: string;
}

/** The editor's marks, for its form's fields. */
export const FieldFlashContext = createContext<FieldMarks | null>(null);

/** A ref whose element stays marked while the step on show changed `field`; null names no field. */
export const useFieldFlash = <T extends HTMLElement>(
  field: FlashField | null,
): RefObject<T | null> => {
  const marks = useContext(FieldFlashContext);
  return useFlash<T>(marks && field !== null && marks.fields.has(field) ? marks.key : null, true);
};
