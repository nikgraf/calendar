import { type ReactNode, type RefObject, useLayoutEffect, useState } from 'react';

const CANDIDATES = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

/** What Tab can reach in a panel, in document order: enabled, shown, not taken out of the order. */
const tabbables = (panel: HTMLElement): Array<HTMLElement> =>
  [...panel.querySelectorAll<HTMLElement>(CANDIDATES)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      element.checkVisibility({ visibilityProperty: true }),
  );

/**
 * An empty stop just outside the panel that Tab or Shift+Tab lands on
 * when it would leave; it hands focus on before anything paints. Fixed,
 * so it takes no room in a flex row the panel's parent lays out.
 */
function FocusGuard({ onFocus }: { onFocus: (from: Element | null) => void }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 size-px opacity-0"
      data-focus-guard
      onFocus={(focusEvent) => onFocus(focusEvent.relatedTarget)}
      tabIndex={0}
    />
  );
}

/** Each trap's panel and the opener it gives focus back to, kept after it closes. */
const openers = new WeakMap<Element, HTMLElement | null>();

/**
 * Where a closing trap gives focus back: its opener, or — when the opener
 * went with a panel that closed before it — that panel's own opener, and
 * so on out. A dialog keyed by its item (the agent's next request) is
 * replaced in one commit, so the new one saw focus on a button in the old.
 */
const returnTarget = (opener: HTMLElement | null): HTMLElement | null => {
  let target = opener;
  while (target && !target.isConnected) {
    // A removed subtree keeps its parents: walk up to the closed panel.
    let node: Element | null = target;
    while (node && !openers.has(node)) {
      node = node.parentElement;
    }
    target = node ? (openers.get(node) ?? null) : null;
  }
  return target;
};

/**
 * Keeps the keyboard inside a modal panel — a Dialog or a Popover — for
 * as long as this is mounted: focus moves in when it mounts, Tab and
 * Shift+Tab cycle the panel's controls, and focus returns to the opener
 * when it unmounts (`returnTarget`). `children` is the panel itself, with `panelRef` on it
 * and `tabIndex={-1}` so it can hold focus when nothing in it can.
 *
 * Tab is never intercepted. A keydown trap that wraps at the last control
 * cannot tell where inside a date or time field the key is: Chromium steps
 * through the field's segments, then its picker button, on Tab while
 * `document.activeElement` stays on the field — a trap wrapped Tab in a
 * date filter's month back to the first field. Here the browser moves
 * focus as it would anyway, and a guard on either side of the panel
 * catches it on the way out and passes it to the other end. Shift+Tab
 * that wraps onto a date field lands on its first segment, not its last:
 * script focus cannot pick a segment.
 *
 * A control marked `data-initial-focus` takes the first focus (the color
 * picker's current color), else the first control — unless one inside
 * already took it with `autoFocus`.
 */
export function FocusTrap({
  children,
  panelRef,
}: {
  readonly children: ReactNode;
  readonly panelRef: RefObject<HTMLElement | null>;
}) {
  // Read while rendering: React focuses an autoFocus field in the panel
  // during the commit, before any effect here could see the opener.
  const [opener] = useState(() => {
    const active = document.activeElement as HTMLElement | null;
    return active && typeof active.focus === 'function' ? active : null;
  });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    openers.set(panel, opener);
    if (!panel.contains(document.activeElement)) {
      (
        panel.querySelector<HTMLElement>('[data-initial-focus]') ??
        tabbables(panel)[0] ??
        panel
      ).focus();
    }
    // A control that goes away with focus in it (the filter menu's row,
    // replaced by the filter it picked) drops focus onto the page: it
    // comes back to the panel's first control.
    let focused = document.activeElement;
    const track = (focusEvent: FocusEvent) => {
      focused = focusEvent.target as Element;
    };
    const refocus = new MutationObserver(() => {
      if (document.activeElement === document.body && !focused?.isConnected) {
        (tabbables(panel)[0] ?? panel).focus();
      }
    });
    panel.addEventListener('focusin', track);
    refocus.observe(panel, { childList: true, subtree: true });
    return () => {
      refocus.disconnect();
      panel.removeEventListener('focusin', track);
      returnTarget(opener)?.focus();
    };
  }, [opener, panelRef]);

  // Focus arriving from inside the panel is leaving it: on through to the
  // other end. From outside (the page before or after), it is entering.
  const enter = (end: 'first' | 'last') => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const controls = tabbables(panel);
    ((end === 'first' ? controls[0] : controls.at(-1)) ?? panel).focus();
  };
  const fromInside = (from: Element | null) => !!panelRef.current?.contains(from);

  return (
    <>
      <FocusGuard onFocus={(from) => enter(fromInside(from) ? 'last' : 'first')} />
      {children}
      <FocusGuard onFocus={(from) => enter(fromInside(from) ? 'first' : 'last')} />
    </>
  );
}
