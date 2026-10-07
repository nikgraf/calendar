import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The open dialogs of this window, in mount order. Each listens for keys
 * on window, and stopPropagation does not stop a listener on the same
 * target: one Escape used to close them all (dismissing an agent request
 * also threw away a half-edited event). Only the topmost — highest
 * zIndex, then the last opened — answers Escape and traps Tab.
 */
const openDialogs: Array<{ readonly zIndex: number }> = [];

const topmost = () =>
  openDialogs.reduce<{ readonly zIndex: number } | undefined>(
    (top, entry) => (top === undefined || entry.zIndex >= top.zIndex ? entry : top),
    undefined,
  );

/**
 * Whether a dialog is open in this window: the calendar's own keys (and its
 * paste) stand back, including behind the agent approval dialog, which the
 * calendar does not open itself.
 */
export const isDialogOpen = (): boolean => openDialogs.length > 0;

/**
 * The one modal shell for the editor, the ⌘K bar and the dialogs inside
 * the settings window: dialog semantics, Escape closes, focus moves inside
 * on open and is trapped there (Tab cycles), and returns to the opener on
 * close. The
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
  // Callers pass inline closures; the effect must run once per mount, or
  // its cleanup would hand focus back to the opener on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const entry = { zIndex };
    openDialogs.push(entry);
    const active = document.activeElement as HTMLElement | null;
    const opener = active && typeof active.focus === 'function' ? active : null;
    const panel = panelRef.current;
    // Focus the first control unless something inside already took it
    // (an autofocused title field).
    if (panel && !panel.contains(document.activeElement)) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    const onKeyDown = (key: KeyboardEvent) => {
      if (topmost() !== entry) {
        return;
      }
      if (key.key === 'Escape') {
        key.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (key.key !== 'Tab' || !panel) {
        return;
      }
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) {
        key.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (key.shiftKey && document.activeElement === first) {
        key.preventDefault();
        last.focus();
      } else if (!key.shiftKey && document.activeElement === last) {
        key.preventDefault();
        first.focus();
      }
    };
    // On window, capture phase: real key events pass through here first,
    // and the e2e suite's synthetic Escape is dispatched on window.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      openDialogs.splice(openDialogs.indexOf(entry), 1);
      window.removeEventListener('keydown', onKeyDown, true);
      opener?.focus();
    };
    // zIndex is fixed per call site; re-running would re-open the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    </div>
  );
}
