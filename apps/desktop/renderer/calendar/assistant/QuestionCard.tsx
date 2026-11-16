import {
  asSaidOption,
  contactOption,
  type OptionLabel,
  type PlaceChoice,
  pickedCandidate,
  placeOptions,
  questionCount,
  questionText,
  readsAsSaid,
  type useThreadEditor,
} from '@calendar/app-state';
import { useState } from 'react';
import { Button } from '../../ui/Button.tsx';
import { CheckIcon } from '../../ui/icons.tsx';
import { PlaceMap } from './PlaceMap.tsx';

/** The question map's height in the panel. */
const MAP_HEIGHT = 140;

/**
 * One answer, a full-width row: what it is over what tells it apart,
 * and "Taken" on the one the draft holds now. A place leads with its
 * pin's number on the map above (`lead`), and the pointer on it raises
 * that pin (`onHover`); the text as said, which has no pin, leads with
 * an empty dashed one.
 */
function Option({
  disabled,
  label,
  lead,
  lit = false,
  onClick,
  onHover,
  pressed,
  testId,
}: {
  readonly disabled: boolean;
  readonly label: OptionLabel;
  readonly lead?: number | 'none' | undefined;
  /** Its pin is under the pointer. */
  readonly lit?: boolean | undefined;
  readonly onClick: () => void;
  readonly onHover?: ((on: boolean) => void) | undefined;
  readonly pressed: boolean;
  readonly testId: string;
}) {
  return (
    <button
      aria-pressed={pressed}
      className={`flex min-h-10 w-full items-center gap-2.5 rounded-control border border-hairline px-2.5 py-1.5 text-left enabled:hover:bg-surface-subtle disabled:opacity-50 ${
        lit ? 'bg-surface-subtle' : 'bg-surface'
      }`}
      data-testid={testId}
      disabled={disabled}
      onBlur={() => onHover?.(false)}
      onClick={onClick}
      onFocus={() => onHover?.(true)}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      type="button"
    >
      {lead === 'none' ? (
        <span className="size-5 shrink-0 rounded-full border-[1.5px] border-dashed border-hairline-strong" />
      ) : null}
      {typeof lead === 'number' ? (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-primary tabular-nums">
          {lead}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold text-ink">{label.title}</span>
        {label.detail ? (
          <span className="truncate text-xs text-ink-secondary">{label.detail}</span>
        ) : null}
      </span>
      {pressed ? (
        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-ink">
          <CheckIcon size={12} />
          Taken
        </span>
      ) : null}
    </button>
  );
}

/**
 * What the Assistant asks, one question at a time under its newest card
 * (`questionsAsked`): its number among those its turn brought, the
 * question, the answers as rows and Skip. An answer is a step (going back
 * over it asks again); Skip leaves the form as it is. "Which place?"
 * shows its places on one map above the rows, numbered like them: a pin
 * takes its place as its row does, and the row under the pointer raises
 * its pin. The answers keep the ids the rows of choices had.
 */
export function QuestionCard({ editor }: { readonly editor: ReturnType<typeof useThreadEditor> }) {
  // The place under the pointer, of the choice it was over: a pick takes
  // the row away with no pointer leaving, and a later question starts clear.
  const [pointer, setPointer] = useState<
    { readonly choice: PlaceChoice; readonly index: number } | undefined
  >(undefined);
  const {
    eventModel,
    inviteeChoices,
    keepPlace,
    pickInvitee,
    pickPlaceChoice,
    placeGeo,
    questions,
    settled,
    skipQuestion,
  } = editor;
  const question = questions.current;
  if (question === undefined) {
    return null;
  }
  const disabled = !settled;
  const header = (
    <div className="flex items-center justify-between gap-2">
      <span
        className="text-xs font-semibold tracking-wide text-ink-secondary uppercase"
        data-testid="draft-question-count"
      >
        {questionCount(questions)}
      </span>
      <Button
        data-testid="draft-question-skip"
        disabled={disabled}
        onClick={skipQuestion}
        size="sm"
        variant="ghost"
      >
        Skip
      </Button>
    </div>
  );
  const asked = (
    <p aria-level={3} className="text-sm font-semibold text-ink" role="heading">
      {questionText(question)}
    </p>
  );
  if (question.kind === 'place') {
    const { choice } = question;
    const held = pickedCandidate(choice, eventModel.location, placeGeo);
    const labels = placeOptions(choice);
    const hovered = pointer?.choice === choice ? pointer.index : undefined;
    const setHovered = (index: number | undefined) =>
      setPointer(index === undefined ? undefined : { choice, index });
    return (
      <section
        className="flex flex-col gap-1.5 rounded-popover bg-fill p-2.5"
        data-kind="place"
        data-testid="draft-question"
      >
        {header}
        <div className="flex flex-col gap-1.5" data-testid="draft-place-choices">
          {asked}
          <PlaceMap
            disabled={disabled}
            height={MAP_HEIGHT}
            lifted={hovered}
            names={labels.map((label) => label.title)}
            numbered
            onHover={setHovered}
            onPick={(index) => {
              const candidate = choice.candidates[index];
              if (candidate !== undefined) {
                pickPlaceChoice(candidate);
              }
            }}
            places={choice.candidates.map((candidate) => candidate.geo)}
            testId="draft-place-map"
          />
          {choice.candidates.map((candidate, index) => (
            <Option
              disabled={disabled}
              key={`${candidate.source}:${candidate.geo.source}:${String(index)}`}
              label={labels[index] ?? { detail: '', title: '' }}
              lead={index + 1}
              lit={hovered === index}
              onClick={() => pickPlaceChoice(candidate)}
              onHover={(on) => setHovered(on ? index : undefined)}
              pressed={held === candidate}
              testId={`draft-place-pick-${String(index)}`}
            />
          ))}
          <Option
            disabled={disabled}
            label={asSaidOption(choice)}
            lead="none"
            onClick={keepPlace}
            pressed={readsAsSaid(choice, eventModel.location, placeGeo)}
            testId="draft-place-keep"
          />
        </div>
      </section>
    );
  }
  const { choice } = question;
  // The ids count the draft's names, as the rows of choices did.
  const index = inviteeChoices.indexOf(choice);
  return (
    <section
      className="flex flex-col gap-1.5 rounded-popover bg-fill p-2.5"
      data-kind="guest"
      data-testid="draft-question"
    >
      {header}
      <div data-testid="draft-invitee-choices">
        <div
          className="flex flex-col gap-1.5"
          data-testid={`draft-invitee-choice-${String(index)}`}
        >
          {asked}
          {choice.contacts.map((contact, at) => (
            <Option
              disabled={disabled}
              key={contact.email}
              label={contactOption(contact)}
              onClick={() => pickInvitee(choice.name, contact)}
              pressed={false}
              testId={`draft-invitee-pick-${String(index)}-${String(at)}`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
