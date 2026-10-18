import type { PlaceChoice } from '@calendar/app-state';
import { type PlaceCandidate, placeCandidateLabel } from '@calendar/core';
import { Button } from '../ui/Button.tsx';

/**
 * The places a turn's location text could mean, when none was taken
 * without asking: each as a button (a click makes it the place, pin and
 * all — a past place by its text, a search hit by name and address) and
 * "Keep …" to leave the text as said. Nothing is picked for the user.
 */
export function PlaceChoices({
  choice,
  disabled,
  onKeep,
  onPick,
}: {
  readonly choice: PlaceChoice;
  readonly disabled: boolean;
  readonly onKeep: () => void;
  readonly onPick: (candidate: PlaceCandidate) => void;
}) {
  return (
    <div className="flex flex-col gap-1" data-testid="draft-place-choices">
      <span className="text-xs text-ink-secondary">Which place for “{choice.text}”?</span>
      <div className="flex flex-wrap gap-1.5">
        {choice.candidates.map((candidate, index) => (
          <Button
            data-testid={`draft-place-pick-${String(index)}`}
            disabled={disabled}
            key={`${candidate.source}:${candidate.geo.source}`}
            onClick={() => onPick(candidate)}
            size="sm"
            title={candidate.geo.name ?? candidate.geo.source}
          >
            {placeCandidateLabel(candidate)}
          </Button>
        ))}
        <Button
          data-testid="draft-place-keep"
          disabled={disabled}
          onClick={onKeep}
          size="sm"
          variant="ghost"
        >
          Keep “{choice.text}”
        </Button>
      </div>
    </div>
  );
}
