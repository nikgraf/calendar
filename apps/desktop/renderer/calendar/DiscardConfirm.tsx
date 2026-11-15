import { DISCARD_ANSWERS } from '@calendar/app-state';
import { Button } from '../ui/Button.tsx';
import { CALLOUT_CLASS } from '../ui/calloutStyles.ts';

/**
 * The question before an editor that holds something goes — Cancel, the
 * X, Escape, or another item, slot or search opened over it — drawn above
 * the editor's footer like `MoveConfirm`, so it is on screen wherever the
 * form is scrolled to. Keep Editing takes the focus: Enter and Escape
 * both leave the editor as it is; discarding is a deliberate click.
 */
export function DiscardConfirm({
  onAnswer,
  question,
}: {
  readonly onAnswer: (discard: boolean) => void;
  readonly question: string;
}) {
  return (
    <div
      aria-label="Discard changes?"
      className={`${CALLOUT_CLASS.danger} p-3 text-sm`}
      data-testid="discard-confirm"
      role="alertdialog"
    >
      <p>{question}</p>
      <div className="mt-2 flex justify-end gap-2">
        <Button
          // The question comes up from a key or a click elsewhere: the focus
          // moves to the safe answer, as a sheet's default button holds it.
          autoFocus
          data-testid="discard-confirm-no"
          onClick={() => onAnswer(false)}
          size="sm"
          variant="secondary"
        >
          {DISCARD_ANSWERS.keep}
        </Button>
        <Button
          data-testid="discard-confirm-yes"
          onClick={() => onAnswer(true)}
          size="sm"
          variant="danger"
        >
          {DISCARD_ANSWERS.discard}
        </Button>
      </div>
    </div>
  );
}
