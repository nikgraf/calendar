import { type DraftField, type DraftFlash, TURN_FLASH_MS } from '@calendar/app-state';
import { createContext, type RefObject, useContext, useEffect, useRef } from 'react';

/**
 * A brief tint behind an element a turn just changed: its background
 * starts at the `highlight` token and eases back to its own over
 * `TURN_FLASH_MS` — once per `key` (a turn's id), nothing while it is
 * null. A color fade, not movement, so reduced motion keeps it. The next
 * key (or the element leaving) cancels one still running, so its own
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
    const animation = element.animate([{ backgroundColor: highlight }, { backgroundColor: own }], {
      duration: TURN_FLASH_MS,
      easing: 'ease-out',
    });
    return () => animation.cancel();
  }, [key]);
  return ref;
};

/** The editor's flash (`useThreadEditor().flash`), for its form's fields. */
export const FieldFlashContext = createContext<DraftFlash | null>(null);

/** A ref that flashes when the last turn changed `field`; null names no field (nothing flashes). */
export const useFieldFlash = <T extends HTMLElement>(
  field: DraftField | null,
): RefObject<T | null> => {
  const flash = useContext(FieldFlashContext);
  return useFlash<T>(flash && field !== null && flash.fields.has(field) ? flash.key : null);
};
