import { useEffect, useRef, type ReactNode } from 'react';
import { makeDialogStack } from './dialogStack.ts';
import { FocusTrap } from './ui/FocusTrap.tsx';

/** This window's open dialogs: only the topmost answers keys (dialogStack.ts). */
const dialogs = makeDialogStack(window);

/**
 * Whether a dialog is open in this window: the calendar's own keys (and its
 * paste) stand back, including behind the agent approval dialog, which the
 * calendar does not open itself.
 */
export const isDialogOpen = (): boolean => dialogs.isOpen();

/**
 * Registers a lighter surface (a popover) with the same stack, so only
 * the topmost one answers Escape and the calendar's keys stand back
 * while it is open. Returns what closes it.
 */
export const openDialogLayer = (zIndex: number, onEscape: () => void): (() => void) =>
  dialogs.open(zIndex, onEscape);

/**
 * The one modal shell for the editor, the ⌘K bar and the dialogs inside
 * the settings window: dialog semantics, Escape closes, focus moves inside
 * on open and stays there (Tab cycles, `FocusTrap`), and returns to the
 * opener on close. The
 * backdrop is a real button so keyboard and assistive-tech users can
 * dismiss too — the same pattern the calendar color picker already used,
 * while the three big modals were plain divs that only a mouse could
 * close.
 */
export function Dialog({
  align = 'center',
  children,
  label,
  onClose,
  panelClassName,
  zIndex = 30,
}: {
  align?: 'center' | 'top';
  children: ReactNode;
  /** Accessible name of the dialog. */
  label: string;
  onClose: () => void;
  panelClassName: string;
  zIndex?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Callers pass inline closures; the dialog registers once per mount, or
  // every render would move it to the top of the stack among its zIndex.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(
    () => dialogs.open(zIndex, () => onCloseRef.current()),
    // zIndex is fixed per call site; re-running would re-open the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The scrim is black in both appearances, not a token: it dims whatever
  // is under it, light or dark.
  return (
    <div
      className={`fixed inset-0 flex justify-center bg-black/30 ${
        align === 'top' ? 'items-start pt-28' : 'items-center'
      }`}
      style={{ zIndex }}
    >
      <button
        aria-label="Close"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <FocusTrap panelRef={panelRef}>
        <div
          aria-label={label}
          aria-modal="true"
          className={`relative ${panelClassName}`}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          {children}
        </div>
      </FocusTrap>
    </div>
  );
}
