import {
  type FlashField,
  type StepField,
  TURN_FLASH_FADE_MS,
  TURN_FLASH_HOLD_MS,
} from '@calendar/app-state';
import { createContext, type RefObject, useContext, useEffect, useRef } from 'react';

/**
 * A tint behind an element something just changed, in the `highlight`
 * token, once per `key`, nothing while it is null. Fleeting (a search
 * turn's chip), it holds for `TURN_FLASH_HOLD_MS` and eases back to the
 * element's own color over `TURN_FLASH_FADE_MS`: an animation, its color
 * read as it starts. `lasting` (the fields the editor's step on show
 * changed), it stays until the key changes: the element carries
 * `data-marked` and the stylesheet tints it (App.css), so the mark
 * follows the appearance when that changes under it — a color baked into
 * an animation stayed the light theme's on a dark form. A color change,
 * not movement, so reduced motion keeps it. The next key (or the element
 * leaving) ends one that is up.
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
    if (lasting) {
      element.dataset['marked'] = '';
      return () => {
        delete element.dataset['marked'];
      };
    }
    const highlight = getComputedStyle(document.documentElement)
      .getPropertyValue('--highlight')
      .trim();
    const own = getComputedStyle(element).backgroundColor;
    const duration = TURN_FLASH_HOLD_MS + TURN_FLASH_FADE_MS;
    const animation = element.animate(
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
    return () => animation.cancel();
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
