import { type PlaceChoice, pickedCandidate, readsAsSaid } from '@calendar/app-state';
import { type GeoLocation, type PlaceCandidate, placeCandidateLabel } from '@calendar/core';
import { Button } from '../ui/Button.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { XIcon } from '../ui/icons.tsx';

/**
 * The places a turn's location text could mean, the one the field reads
 * pressed: each as a button (a click makes it the place, pin and all — a
 * past place by its text, a search hit by name and address), the text
 * as said as one more, and × to let the row go.
 */
export function PlaceChoices({
  choice,
  disabled,
  geo,
  location,
  onDismiss,
  onKeep,
  onPick,
}: {
  readonly choice: PlaceChoice;
  readonly disabled: boolean;
  /** The coordinates the form vouches for now, if any. */
  readonly geo: GeoLocation | undefined;
  /** The location field as it reads now. */
  readonly location: string;
  readonly onDismiss: () => void;
  readonly onKeep: () => void;
  readonly onPick: (candidate: PlaceCandidate) => void;
}) {
  const picked = pickedCandidate(choice, location, geo);
  const asSaid = readsAsSaid(choice, location, geo);
  return (
    <div className="flex flex-col gap-1" data-testid="draft-place-choices">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-secondary">Place for “{choice.text}”</span>
        <IconButton
          data-testid="draft-place-dismiss"
          disabled={disabled}
          label="Hide the places"
          onClick={onDismiss}
          size="sm"
        >
          <XIcon size={12} />
        </IconButton>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {choice.candidates.map((candidate, index) => {
          const chosen = picked === candidate;
          return (
            <Button
              aria-pressed={chosen}
              className={chosen ? 'ring-2 ring-focus' : ''}
              data-testid={`draft-place-pick-${String(index)}`}
              disabled={disabled}
              key={`${candidate.source}:${candidate.geo.source}`}
              onClick={() => onPick(candidate)}
              size="sm"
              title={candidate.geo.name ?? candidate.geo.source}
            >
              {placeCandidateLabel(candidate)}
            </Button>
          );
        })}
        <Button
          aria-pressed={asSaid}
          className={asSaid ? 'ring-2 ring-focus' : ''}
          data-testid="draft-place-keep"
          disabled={disabled}
          onClick={onKeep}
          size="sm"
          variant="ghost"
        >
          As said: “{choice.text}”
        </Button>
      </div>
    </div>
  );
}
