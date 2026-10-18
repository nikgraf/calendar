import {
  type DraftFlash,
  type FlashField,
  TURN_FLASH_FADE_MS,
  TURN_FLASH_HOLD_MS,
} from '@calendar/app-state';
import { createContext, type RefObject, useContext, useEffect, useRef } from 'react';

/**
 * A tint behind an element a turn just changed: its background holds the
 * `highlight` token for `TURN_FLASH_HOLD_MS`, then eases back to its own
 * over `TURN_FLASH_FADE_MS` — once per `key` (a turn's id), nothing while
 * it is null. A color fade, not movement, so reduced motion keeps it. The
 * next key (or the element leaving) cancels one still running, so its own
 * color is read clean.
 */
export const useFlash = <T extends HTMLElement>(key: string | null): RefObject<T | null> => {
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
  }, [key]);
  return ref;
};

/** The editor's flash (`useThreadEditor().flash`), for its form's fields. */
export const FieldFlashContext = createContext<DraftFlash | null>(null);

/** A ref that flashes when the last turn changed `field`; null names no field (nothing flashes). */
export const useFieldFlash = <T extends HTMLElement>(
  field: FlashField | null,
): RefObject<T | null> => {
  const flash = useContext(FieldFlashContext);
  return useFlash<T>(flash && field !== null && flash.fields.has(field) ? flash.key : null);
};
