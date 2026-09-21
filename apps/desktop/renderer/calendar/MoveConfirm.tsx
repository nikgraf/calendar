import type { useMoveConfirmation } from '@calendar/app-state';

/**
 * The inline "this move drops …" question the event and task editors
 * show before a lossy move. The e2e suite relies on the test id and the
 * Keep here / Move anyway labels.
 */
export function MoveConfirm({
  moveConfirmation,
}: {
  moveConfirmation: ReturnType<typeof useMoveConfirmation>;
}) {
  if (moveConfirmation.pendingSummary === null) {
    return null;
  }
  return (
    <div
      className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      data-testid="move-confirm"
      role="alertdialog"
    >
      <p>{moveConfirmation.pendingSummary}</p>
      <div className="mt-2 flex justify-end gap-2">
        <button
          className="rounded-lg px-3 py-1 hover:bg-amber-100"
          onClick={() => moveConfirmation.answer(false)}
          type="button"
        >
          Keep here
        </button>
        <button
          className="rounded-lg bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-500"
          onClick={() => moveConfirmation.answer(true)}
          type="button"
        >
          Move anyway
        </button>
      </div>
    </div>
  );
}
