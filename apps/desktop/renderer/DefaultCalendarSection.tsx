import { defaultCalendarGroups, useAccounts, useDefaultCalendarEditor } from '@calendar/app-state';
import { calendarGroupLabel } from './calendar/calendarGroupLabel.ts';
import { FIELD_CLASS, LABEL_CLASS } from './ui/fieldStyles.ts';

const LAST_USED = 'lastUsed';
const MISSING = 'missing';

/**
 * Where new events start — the editor's and the Assistant's alike: a
 * calendar picked here, or the one used last. The setting travels in the
 * settings file, so a calendar picked on the iPhone that this Mac lacks
 * shows as such and leaves new events on the one used last.
 */
export function DefaultCalendarSection() {
  const editor = useDefaultCalendarEditor();
  const accounts = useAccounts();
  if (!editor) {
    return null;
  }
  const { choices, choose, place } = editor;
  const accountLabel = (accountId: string) =>
    accounts.find((account) => account.id === accountId)?.email ?? accountId;
  const value =
    place.kind === 'here' ? place.calendarKey : place.kind === 'missing' ? MISSING : LAST_USED;
  return (
    <section className="rounded-popover bg-surface-subtle p-4" data-testid="default-calendar">
      <h2 className="font-medium">New events</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        New events and the Assistant’s drafts start in this calendar; the editor can still put one
        in another. Last used is the one you last saved a new event in since Solunivo opened.
      </p>
      <label className={`${LABEL_CLASS} mt-3 block`}>
        Default calendar
        <select
          className={`${FIELD_CLASS} mt-1`}
          data-testid="default-calendar-select"
          onChange={(change) => {
            const next = change.target.value;
            if (next === LAST_USED) {
              choose('lastUsed');
              return;
            }
            const choice = choices.find((entry) => entry.key === next);
            if (choice) {
              choose(choice.ref);
            }
          }}
          value={value}
        >
          <option value={LAST_USED}>Last used</option>
          {place.kind === 'missing' ? (
            <option disabled value={MISSING}>
              {place.label} (not on this Mac)
            </option>
          ) : null}
          {defaultCalendarGroups(choices, (calendar) =>
            calendarGroupLabel(calendar, accountLabel),
          ).map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.choices.map((choice) => (
                <option disabled={choice.ambiguous} key={choice.key} value={choice.key}>
                  {choice.ambiguous
                    ? `${choice.calendar.summary} (two calendars have this name)`
                    : choice.calendar.summary}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
    </section>
  );
}
