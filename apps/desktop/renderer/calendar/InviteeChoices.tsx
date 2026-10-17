import { choiceLabel, choiceQuestion, type InviteeChoice } from '@calendar/app-state';
import type { Contact } from '@calendar/core';
import { Button } from '../ui/Button.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { XIcon } from '../ui/icons.tsx';

/**
 * The names a turn invited that found no one contact: for each, the
 * contacts it might be as buttons (a click makes that one a guest), or a
 * line saying no contact has the name, and × to let it go. Nothing is
 * picked for the user.
 */
export function InviteeChoices({
  choices,
  disabled,
  onDismiss,
  onPick,
}: {
  readonly choices: ReadonlyArray<InviteeChoice>;
  readonly disabled: boolean;
  readonly onDismiss: (name: string) => void;
  readonly onPick: (name: string, contact: Contact) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="draft-invitee-choices">
      {choices.map((choice, index) => (
        <div
          className="flex flex-col gap-1"
          data-testid={`draft-invitee-choice-${String(index)}`}
          key={choice.name}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink-secondary">{choiceQuestion(choice)}</span>
            <IconButton
              data-testid={`draft-invitee-dismiss-${String(index)}`}
              disabled={disabled}
              label={`Don’t invite ${choice.name}`}
              onClick={() => onDismiss(choice.name)}
              size="sm"
            >
              <XIcon size={12} />
            </IconButton>
          </div>
          {choice.contacts.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {choice.contacts.map((contact, at) => (
                <Button
                  data-testid={`draft-invitee-pick-${String(index)}-${String(at)}`}
                  disabled={disabled}
                  key={contact.email}
                  onClick={() => onPick(choice.name, contact)}
                  size="sm"
                  title={contact.email}
                >
                  {choiceLabel(contact, choice)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
