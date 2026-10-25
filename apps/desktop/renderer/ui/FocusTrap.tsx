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

/**
 * Where the last trap to close gave focus back, until its commit is done.
 * A trap that opens in that same commit — a dialog keyed by its item,
 * replaced by the next one (the agent's queued requests) — gives focus
 * back there too: what it saw focused while rendering is gone by then (a
 * button or the scrim of the dialog it replaces) or is the page (a click
 * on Decline disables the button that had focus).
 */
let handedBack: HTMLElement | null = null;

/**
 * Keeps the keyboard inside a modal panel — a Dialog or a Popover — for
 * as long as this is mounted: focus moves in when it mounts, Tab and
 * Shift+Tab cycle the panel's controls, and focus returns to the opener
 * when it unmounts. `children` is the panel itself, with `panelRef` on it
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
  const [seen] = useState(() => {
    const active = document.activeElement as HTMLElement | null;
    return active && typeof active.focus === 'function' ? active : null;
  });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    // Gone by now, or the page: then a trap this one replaced in this
    // commit has given focus back already, and this one returns there.
    const opener = seen?.isConnected && seen !== document.body ? seen : (handedBack ?? seen);
    if (!panel.contains(document.activeElement)) {
      (
        panel.querySelector<HTMLElement>('[data-initial-focus]') ??
        tabbables(panel)[0] ??
        panel
      ).focus();
    }
    // A control that goes away with focus in it (a setup step's button,
    // replaced by the next step) drops focus onto the page: it comes back
    // to the panel itself, where Enter does nothing and Tab goes on. Not
    // to the first control — a step's first is Skip.
    let focused = document.activeElement;
    const track = (focusEvent: FocusEvent) => {
      focused = focusEvent.target as Element;
    };
    const refocus = new MutationObserver(() => {
      if (document.activeElement === document.body && !focused?.isConnected) {
        panel.focus();
      }
    });
    panel.addEventListener('focusin', track);
    refocus.observe(panel, { childList: true, subtree: true });
    return () => {
      refocus.disconnect();
      panel.removeEventListener('focusin', track);
      opener?.focus();
      handedBack = opener?.isConnected ? opener : null;
      queueMicrotask(() => {
        handedBack = null;
      });
    };
  }, [seen, panelRef]);

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
