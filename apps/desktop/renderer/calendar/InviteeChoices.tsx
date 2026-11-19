import { choiceQuestion, type InviteeChoice } from '@calendar/app-state';
import { IconButton } from '../ui/IconButton.tsx';
import { XIcon } from '../ui/icons.tsx';

/**
 * The names a turn invited that no contact has: a line each saying so,
 * and × to let it go. A name that found contacts is a question of its own
 * (`QuestionCard`). The ids count the draft's names (`indexOf`), so a
 * name keeps its number whether asked or told.
 */
export function InviteeChoices({
  choices,
  disabled,
  indexOf,
  onDismiss,
}: {
  readonly choices: ReadonlyArray<InviteeChoice>;
  readonly disabled: boolean;
  readonly indexOf: (choice: InviteeChoice) => number;
  readonly onDismiss: (name: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="draft-invitee-choices">
      {choices.map((choice) => {
        const index = String(indexOf(choice));
        return (
          <div
            className="flex items-center justify-between gap-2"
            data-testid={`draft-invitee-choice-${index}`}
            key={choice.name}
          >
            <span className="text-xs text-ink-secondary">{choiceQuestion(choice)}</span>
            <IconButton
              data-testid={`draft-invitee-dismiss-${index}`}
              disabled={disabled}
              label={`Don’t invite ${choice.name}`}
              onClick={() => onDismiss(choice.name)}
              size="sm"
            >
              <XIcon size={12} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
