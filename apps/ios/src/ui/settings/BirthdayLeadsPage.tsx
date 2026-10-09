import { BIRTHDAY_LEAD_DAYS, type BirthdayLeadDays, leadDaysLabel } from '@calendar/core';
import { CheckRow, Section, SettingsPage } from './GroupedList.tsx';
import { useNotificationSettings } from './NotificationSettings.tsx';

/**
 * When a birthday notifies: any of the lead times, each one checked or
 * not. People with times of their own (Custom per Person) keep those.
 */
export function BirthdayLeadsPage() {
  const { birthdays } = useNotificationSettings();
  const settings = birthdays.settings;
  if (!settings) {
    return <SettingsPage testID="settings-page-birthday-leads">{null}</SettingsPage>;
  }
  const toggle = (lead: BirthdayLeadDays) => {
    const on = settings.leadDays.includes(lead);
    birthdays.save({
      leadDays: on
        ? settings.leadDays.filter((value) => value !== lead)
        : [...settings.leadDays, lead],
    });
  };
  return (
    <SettingsPage testID="settings-page-birthday-leads">
      <Section footer="Each birthday notifies at every time checked here. People with times of their own keep those.">
        {BIRTHDAY_LEAD_DAYS.map((lead) => {
          const checked = settings.leadDays.includes(lead);
          return (
            <CheckRow
              checked={checked}
              key={lead}
              kind="checkbox"
              onPress={() => toggle(lead)}
              // The suffix lets the e2e flow assert the state without a query.
              testID={`birthday-lead-${String(lead)}${checked ? '-on' : ''}`}
              title={leadDaysLabel(lead)}
            />
          );
        })}
      </Section>
    </SettingsPage>
  );
}
