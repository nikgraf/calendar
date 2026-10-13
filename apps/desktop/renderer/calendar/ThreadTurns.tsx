import { earlierTurnsLabel, TURNS_SHOWN, visibleTurns } from '@calendar/app-state';
import { useState } from 'react';
import { Button } from '../ui/Button.tsx';
import { ChevronDownIcon } from '../ui/icons.tsx';

/**
 * A thread's turns, hung under the field they were typed into as an
 * extension of it — the same card, a hairline between the field and each
 * row — newest first: what was said and what it changed, wrapped in full,
 * the newest with Undo. Two show until the last row, "+N earlier
 * queries ⌄" (the tint color and a disclosure chevron, the way "Show
 * More" reads on Apple's platforms), opens the rest. A row eases in when
 * it comes into the list (`turn-in` in App.css) — a new turn at the top,
 * older ones as the list opens; the list itself mounts with its first
 * turn, and `resting` names turns already seen (a panel shown again) that
 * just stand. The create thread (drafts) and the search thread (filters)
 * share it; `testIdPrefix` keeps each one's ids.
 */
export function ThreadTurns({
  listClassName = '',
  onUndo,
  resting,
  testIdPrefix = 'draft',
  turns,
  undoDisabled,
}: {
  /** The rows' box: the search header caps an opened list's height. */
  listClassName?: string;
  onUndo: () => void;
  /** Turns on screen before the list mounted: they do not ease in again. */
  resting?: ReadonlySet<string> | undefined;
  testIdPrefix?: string;
  turns: ReadonlyArray<{
    readonly id: string;
    readonly summary: string;
    readonly utterance: string;
  }>;
  undoDisabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { hidden, shown } = visibleTurns(turns, expanded);
  const newest = shown[0];
  return (
    <div className="border-t border-ink/10">
      <ol className={`divide-y divide-ink/10 ${listClassName}`}>
        {shown.map((turn) => (
          // A one-track grid whose child clips: `turn-in` opens the row's
          // height, so the turns under it slide down rather than jump.
          <li
            className={resting?.has(turn.id) ? 'grid' : 'turn-in grid'}
            data-testid={`${testIdPrefix}-turn`}
            key={turn.id}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex items-start gap-2 py-1.5 pr-1 pl-2.5 text-xs">
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="block text-ink">“{turn.utterance}”</span>
                  <span
                    className="block text-ink-secondary"
                    data-testid={`${testIdPrefix}-turn-summary`}
                  >
                    {turn.summary}
                  </span>
                </span>
                {turn === newest ? (
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
              </div>
            </div>
          </li>
        ))}
      </ol>
      {turns.length > TURNS_SHOWN ? (
        // The card's last row; one button for both ways, so the keyboard
        // focus stays on it.
        <button
          aria-expanded={expanded}
          className="flex w-full items-center gap-0.5 border-t border-ink/10 py-1.5 pr-1 pl-2.5 text-left text-xs font-medium text-primary hover:bg-hairline focus-visible:bg-hairline focus-visible:outline-none"
          data-testid={`${testIdPrefix}-turns-${expanded ? 'less' : 'more'}`}
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {expanded ? 'Show less' : earlierTurnsLabel(hidden)}
          <ChevronDownIcon
            className={`transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
            size={12}
            strokeWidth={2.25}
          />
        </button>
      ) : null}
    </div>
  );
}
