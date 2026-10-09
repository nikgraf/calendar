import type { EditorConfirmRequest, useMoveConfirmation } from '@calendar/app-state';
import { CALLOUT_CLASS } from '../ui/calloutStyles.ts';

/**
 * The buttons for each question. The e2e suite relies on the test ids and
 * on the move labels ("Keep here" / "Move anyway"); a delete's answer is
 * "Delete" like the editor's own button, so tests press it by test id.
 */
const labels = (request: EditorConfirmRequest): { readonly no: string; readonly yes: string } => {
  switch (request.kind) {
    case 'move':
      return { no: 'Keep here', yes: 'Move anyway' };
    case 'convert':
      return { no: `Keep as ${request.subject}`, yes: 'Convert anyway' };
    case 'delete':
      return { no: 'Keep', yes: 'Delete' };
    case 'switch':
      return { no: `Keep as ${request.subject}`, yes: 'Switch' };
  }
};

/**
 * The inline question the event and task editors show before a lossy
 * move, conversion or create-mode switch, and before a delete.
 */
export function MoveConfirm({
  moveConfirmation,
}: {
  moveConfirmation: ReturnType<typeof useMoveConfirmation>;
}) {
  const { pending } = moveConfirmation;
  if (pending === null) {
    return null;
  }
  const { no, yes } = labels(pending);
  return (
    <div
      className={`${CALLOUT_CLASS.warning} mt-4 p-3 text-sm`}
      data-testid="move-confirm"
      role="alertdialog"
    >
      <p>{pending.summary}</p>
      <div className="mt-2 flex justify-end gap-2">
        <button
          className="rounded-lg px-3 py-1 hover:bg-fill"
          data-testid="move-confirm-no"
          onClick={() => moveConfirmation.answer(false)}
          type="button"
        >
          {no}
        </button>
        <button
          className="rounded-lg bg-warning px-3 py-1 font-medium text-on-warning hover:bg-warning/90"
          data-testid="move-confirm-yes"
          onClick={() => moveConfirmation.answer(true)}
          type="button"
        >
          {yes}
        </button>
      </div>
    </div>
  );
}
