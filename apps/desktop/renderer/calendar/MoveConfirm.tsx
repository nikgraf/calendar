import type { EditorConfirmRequest, useMoveConfirmation } from '@calendar/app-state';

/**
 * The buttons for each question. The e2e suite relies on the test id and
 * on the move labels ("Keep here" / "Move anyway").
 */
const labels = (request: EditorConfirmRequest): { readonly no: string; readonly yes: string } => {
  switch (request.kind) {
    case 'move':
      return { no: 'Keep here', yes: 'Move anyway' };
    case 'convert':
      return { no: `Keep as ${request.subject}`, yes: 'Convert anyway' };
    case 'switch':
      return { no: `Keep as ${request.subject}`, yes: 'Switch' };
  }
};

/**
 * The inline "this drops …" question the event and task editors show
 * before a lossy move, conversion or create-mode switch.
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
      className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      data-testid="move-confirm"
      role="alertdialog"
    >
      <p>{pending.summary}</p>
      <div className="mt-2 flex justify-end gap-2">
        <button
          className="rounded-lg px-3 py-1 hover:bg-amber-100"
          onClick={() => moveConfirmation.answer(false)}
          type="button"
        >
          {no}
        </button>
        <button
          className="rounded-lg bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-500"
          onClick={() => moveConfirmation.answer(true)}
          type="button"
        >
          {yes}
        </button>
      </div>
    </div>
  );
}
