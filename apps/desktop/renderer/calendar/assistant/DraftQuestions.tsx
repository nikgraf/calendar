import {
  isAtSlot,
  isGuestQuestion,
  isPlaceQuestion,
  SCOPE_OPTIONS,
  type useThreadEditor,
} from '@calendar/app-state';
import { formatSlotLabel } from '@calendar/core';
import { Button } from '../../ui/Button.tsx';
import { SegmentedControl } from '../../ui/SegmentedControl.tsx';
import { InviteeChoices } from '../InviteeChoices.tsx';
import { PlaceChoices } from '../PlaceChoices.tsx';
import { QuestionCard } from './QuestionCard.tsx';

/**
 * What the assistant asks under its newest card, left out while there is
 * nothing to ask: a caveat the drafts came with, for a series what a
 * change applies to, the free slots a finder phrase found (the draft
 * sits in the pressed one), then its questions one at a time
 * (`QuestionCard`: which place a text means, which contact a name). Not
 * asked, a row each: a lone place that was taken (the text as said a
 * click away), a name no contact has. An answer is a step: going back
 * over it asks again.
 */
export function DraftQuestions({
  editor,
  note,
}: {
  readonly editor: ReturnType<typeof useThreadEditor>;
  /** A caveat about the drafts (the shared text was cut short). */
  readonly note: string | undefined;
}) {
  const {
    assistant,
    dismissInvitee,
    dismissPlace,
    drafts,
    eventModel,
    focusedDraft,
    inviteeChoices,
    keepPlace,
    kinds,
    liveItem,
    moveToSlot,
    pickPlaceChoice,
    placeChoice,
    placeGeo,
    settled,
  } = editor;
  const threadNote = note && drafts.length > 0 ? note : undefined;
  const threadSlots =
    focusedDraft?.slots && focusedDraft.slots.length > 1 && liveItem.kind === 'event'
      ? focusedDraft.slots
      : undefined;
  // A saved series: a phrase changes it at the scope the form is at.
  const scoped = assistant === 'saved' && kinds.mode === 'event' && eventModel.isRecurring;
  // A lone place taken, and names nobody has: told, not asked.
  const lonePlace = placeChoice && !isPlaceQuestion(placeChoice) ? placeChoice : undefined;
  const notes = inviteeChoices.filter((choice) => !isGuestQuestion(choice));
  if (
    !(threadNote || threadSlots || scoped || editor.questions.current || lonePlace || notes.length)
  ) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="draft-thread">
      {threadNote ? (
        <p className="text-xs text-ink-secondary" data-testid="draft-thread-note">
          {threadNote}
        </p>
      ) : null}
      {scoped ? (
        <div className="flex flex-col gap-1" data-testid="draft-scope">
          <span className="text-xs text-ink-secondary">Apply to</span>
          <SegmentedControl
            className="w-full"
            grow
            label="Apply changes to"
            onChange={eventModel.setScope}
            options={SCOPE_OPTIONS.map((option) => ({
              disabled: !settled,
              label: option.label,
              testId: `draft-scope-${option.value}`,
              value: option.value,
            }))}
            size="sm"
            value={eventModel.scope}
          />
        </div>
      ) : null}
      {threadSlots ? (
        // The free slots a finder phrase found: the draft sits in the
        // pressed one; another moves it there, like its block on the grid.
        <div className="flex flex-col gap-1" data-testid="draft-slots">
          <span className="text-xs text-ink-secondary">Free slots</span>
          <div className="flex flex-wrap gap-1.5">
            {threadSlots.map((slot, index) => {
              const chosen = isAtSlot(liveItem, slot);
              return (
                <Button
                  aria-pressed={chosen}
                  className={chosen ? 'ring-2 ring-focus' : ''}
                  data-testid={`draft-slot-${String(index)}`}
                  disabled={!settled}
                  key={`${slot.date}T${slot.startTime}`}
                  onClick={() => moveToSlot(slot)}
                  size="sm"
                >
                  {formatSlotLabel(slot)}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
      <QuestionCard editor={editor} />
      {lonePlace ? (
        <PlaceChoices
          choice={lonePlace}
          disabled={!settled}
          geo={placeGeo}
          location={eventModel.location}
          onDismiss={dismissPlace}
          onKeep={keepPlace}
          onPick={pickPlaceChoice}
        />
      ) : null}
      {notes.length > 0 ? (
        <InviteeChoices
          choices={notes}
          disabled={!settled}
          indexOf={(choice) => inviteeChoices.indexOf(choice)}
          onDismiss={dismissInvitee}
        />
      ) : null}
    </div>
  );
}
