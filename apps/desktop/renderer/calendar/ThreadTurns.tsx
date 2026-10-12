import { Button } from '../ui/Button.tsx';

/**
 * A thread's turns, oldest first: each with what was said and what it
 * changed, the last one with Undo. The create thread (drafts) and the
 * search thread (filters) share it; `testIdPrefix` keeps each one's ids.
 */
export function ThreadTurns({
  onUndo,
  testIdPrefix = 'draft',
  turns,
  undoDisabled,
}: {
  onUndo: () => void;
  testIdPrefix?: string;
  turns: ReadonlyArray<{
    readonly id: string;
    readonly summary: string;
    readonly utterance: string;
  }>;
  undoDisabled: boolean;
}) {
  const last = turns.at(-1);
  return (
    <ol className="flex flex-col gap-1">
      {turns.map((turn) => (
        <li
          className="flex items-start gap-2 rounded-control bg-fill px-2 py-1 text-xs"
          data-testid={`${testIdPrefix}-turn`}
          key={turn.id}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ink">“{turn.utterance}”</span>
            <span
              className="block truncate text-ink-secondary"
              data-testid={`${testIdPrefix}-turn-summary`}
            >
              {turn.summary}
            </span>
          </span>
          {turn === last ? (
            <Button
              data-testid={`${testIdPrefix}-undo`}
              disabled={undoDisabled}
              onClick={onUndo}
              size="sm"
              variant="ghost"
            >
              Undo
            </Button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
