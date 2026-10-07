import { type ReactNode, useEffect } from 'react';

/**
 * A small panel anchored at a screen point, over a transparent backdrop
 * that closes it (so does Escape). Fixed-positioned, so a scrolling
 * parent cannot clip it — the sidebar's color picker, the quick-add
 * field's review card. The backdrop's name is what tests and screen
 * readers see, so it is required.
 */
export function Popover({
  anchor,
  children,
  className = '',
  closeLabel,
  label,
  onClose,
}: {
  /** Top-left of the panel in viewport px; null = closed. */
  readonly anchor: { readonly x: number; readonly y: number } | null;
  readonly children: ReactNode;
  readonly className?: string;
  readonly closeLabel: string;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const open = anchor !== null;
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

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
        role="dialog"
        style={{ left: anchor.x, top: anchor.y }}
      >
        {children}
      </div>
    </>
  );
}
