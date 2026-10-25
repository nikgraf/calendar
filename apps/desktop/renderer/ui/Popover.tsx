import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openDialogLayer } from '../Dialog.tsx';
import { popoverTop } from './popoverPlacement.ts';

/**
 * A small panel anchored at a screen point, over a transparent backdrop
 * that closes it (so does Escape). Fixed-positioned, so a scrolling
 * parent cannot clip it — the Getting started card's menu, a search
 * filter's choices, the calendar color picker in Settings › Accounts.
 * The window cannot clip it either: with no room under its opener it
 * opens above (`popoverTop`). The backdrop's name is what tests and
 * screen readers see, so it is required.
 */
export function Popover({
  align = 'start',
  anchor,
  children,
  className = '',
  closeLabel,
  label,
  onClose,
}: {
  /** 'end': the panel's right edge at `anchor.x`, for an opener at the end of a row. */
  readonly align?: 'end' | 'start';
  /**
   * Where the panel opens, in viewport px: its top at `y`, its left edge
   * at `x` (right edge with `align: 'end'`); null = closed. `above` is
   * the opener's top, where the panel's bottom goes when it does not fit
   * under `y`.
   */
  readonly anchor: {
    readonly above?: number | undefined;
    readonly x: number;
    readonly y: number;
  } | null;
  readonly children: ReactNode;
  readonly className?: string;
  readonly closeLabel: string;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const open = anchor !== null;
  const panelRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  // Callers pass inline closures; the layer is registered once per opening.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  // On the dialog stack, like the modals: Escape reaches the topmost
  // surface only, so a picker over an editor closes alone, and the
  // calendar's own Escape (which leaves the side panel) stands back. A
  // new settings pane closes it too: the old pane is only hidden, and a
  // picker left open in it would take the next Escape from the new one.
  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => onCloseRef.current();
    window.addEventListener('hashchange', close);
    const closeLayer = openDialogLayer(50, close);
    return () => {
      window.removeEventListener('hashchange', close);
      closeLayer();
    };
  }, [open]);

  // Measured before paint, and again whenever the panel's content resizes.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!anchor || !panel) {
      setTop(null);
      return;
    }
    const place = () => setTop(popoverTop(anchor, panel.offsetHeight, window.innerHeight));
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [anchor]);

  if (!anchor) {
    return null;
  }
  return (
    <>
      <button
        aria-label={closeLabel}
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
        type="button"
      />
      <div
        aria-label={label}
        className={`fixed z-50 rounded-popover border border-hairline bg-surface-raised p-2 shadow-xl ${className}`}
        ref={panelRef}
        role="dialog"
        style={
          align === 'end'
            ? // `right`, not a left edge shifted back: a panel whose left edge
              // sits by the window's right would shrink to the sliver left.
              { right: document.documentElement.clientWidth - anchor.x, top: top ?? anchor.y }
            : { left: anchor.x, top: top ?? anchor.y }
        }
      >
        {children}
      </div>
    </>
  );
}
