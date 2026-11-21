import {
  type DefaultCalendarEditor,
  defaultCalendarGroups,
  useAccounts,
  useDefaultCalendarEditor,
} from '@calendar/app-state';
import { calendarGroupLabel } from '../calendarGroupLabel.ts';
import { CheckRow, ColorDot, Section, SettingsPage } from '../GroupedList.tsx';

/** What Settings › Calendar shows beside Default Calendar. */
export const defaultCalendarValue = (editor: DefaultCalendarEditor): string => {
  const { place } = editor;
  if (place.kind === 'lastUsed') {
    return 'Last Used';
  }
  if (place.kind === 'missing') {
    return place.label;
  }
  return editor.choices.find((choice) => choice.key === place.calendarKey)?.calendar.summary ?? '';
};

/**
 * Where new events start — the editor's and the Assistant's alike: Last
 * Used, or a calendar per account (Apple per source), as the editor's own
 * picker lists them. The setting travels in the settings file, so one
 * picked on the Mac that this iPhone lacks shows as such.
 */
export function DefaultCalendarPage() {
  const editor = useDefaultCalendarEditor();
  const accounts = useAccounts();
  if (!editor) {
    return <SettingsPage testID="settings-page-default-calendar">{null}</SettingsPage>;
  }
  const { choices, choose, place } = editor;
  const emailOf = (accountId: string) =>
    accounts.find((account) => account.id === accountId)?.email ?? accountId;
  const groups = defaultCalendarGroups(choices, (calendar) =>
    calendarGroupLabel(calendar, emailOf),
  );
  return (
    <SettingsPage testID="settings-page-default-calendar">
      <Section footer="New events and the Assistant’s drafts start in this calendar; the editor can still put one in another. Last Used is the one you last saved a new event in since Solunivo opened.">
        <CheckRow
          checked={place.kind === 'lastUsed'}
          onPress={() => choose('lastUsed')}
          testID={`default-calendar-last-used${place.kind === 'lastUsed' ? '-on' : ''}`}
          title="Last Used"
        />
        {place.kind === 'missing' ? (
          <CheckRow
            checked
            disabled
            subtitle="Not on this iPhone"
            testID="default-calendar-missing"
            title={place.label}
          />
        ) : null}
      </Section>
      {groups.map((group) => (
        <Section header={group.label} key={group.label}>
          {group.choices.map((choice) => {
            const checked = place.kind === 'here' && place.calendarKey === choice.key;
            return (
              <CheckRow
                checked={checked}
                disabled={choice.ambiguous}
                key={choice.key}
                leading={<ColorDot color={choice.calendar.colorHex} />}
                onPress={() => choose(choice.ref)}
                subtitle={choice.ambiguous ? 'Another calendar has this name' : undefined}
                testID={`default-calendar-option${checked ? '-on' : ''}`}
                title={choice.calendar.summary}
              />
            );
          })}
        </Section>
      ))}
    </SettingsPage>
  );
}
