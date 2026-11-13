import {
  asSaidOption,
  contactOption,
  type OptionLabel,
  pickedCandidate,
  placeOption,
  questionCount,
  questionText,
  readsAsSaid,
  type useThreadEditor,
} from '@calendar/app-state';
import { Button } from '../../ui/Button.tsx';
import { CheckIcon } from '../../ui/icons.tsx';

/**
 * One answer, a full-width row: what it is over what tells it apart,
 * and "Taken" on the one the draft holds now.
 */
function Option({
  disabled,
  label,
  onClick,
  pressed,
  testId,
}: {
  readonly disabled: boolean;
  readonly label: OptionLabel;
  readonly onClick: () => void;
  readonly pressed: boolean;
  readonly testId: string;
}) {
  return (
    <button
      aria-pressed={pressed}
      className="flex min-h-10 w-full items-center justify-between gap-3 rounded-control border border-hairline bg-surface px-2.5 py-1.5 text-left enabled:hover:bg-surface-subtle disabled:opacity-50"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="flex min-w-0 flex-col">
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
 * over it asks again); Skip leaves the form as it is. The answers keep
 * the ids the rows of choices had.
 */
export function QuestionCard({ editor }: { readonly editor: ReturnType<typeof useThreadEditor> }) {
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
    return (
      <section
        className="flex flex-col gap-1.5 rounded-popover bg-fill p-2.5"
        data-kind="place"
        data-testid="draft-question"
      >
        {header}
        <div className="flex flex-col gap-1.5" data-testid="draft-place-choices">
          {asked}
          {choice.candidates.map((candidate, index) => (
            <Option
              disabled={disabled}
              key={`${candidate.source}:${candidate.geo.source}:${String(index)}`}
              label={placeOption(candidate)}
              onClick={() => pickPlaceChoice(candidate)}
              pressed={held === candidate}
              testId={`draft-place-pick-${String(index)}`}
            />
          ))}
          <Option
            disabled={disabled}
            label={asSaidOption(choice)}
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
