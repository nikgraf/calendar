import { useUpdateViewPreferences, useViewPreferences, WEEKDAY_OPTIONS } from '@calendar/app-state';
import { DEFAULT_WEEKEND_DAYS, sortWeekdays, type Weekday } from '@calendar/core';
import { CheckRow, Section, SettingsPage, SwitchRow } from '../GroupedList.tsx';

/**
 * How the calendar is drawn: which days are the weekend, and whether the
 * grids shade them. A view preference that travels in the settings file.
 */
export function CalendarViewPage() {
  const preferences = useViewPreferences();
  const update = useUpdateViewPreferences();
  if (!preferences) {
    return <SettingsPage testID="settings-page-calendar-view">{null}</SettingsPage>;
  }
  const shading = preferences.weekendShading ?? true;
  const days = preferences.weekendDays ?? DEFAULT_WEEKEND_DAYS;
  const toggle = (day: Weekday) =>
    update({
      weekendDays: sortWeekdays(
        days.includes(day) ? days.filter((other) => other !== day) : [...days, day],
      ),
    });
  return (
    <SettingsPage testID="settings-page-calendar-view">
      <Section
        footer="Weekend days get a light background in Day, 2 Days, Week and Month."
        header="Weekends"
      >
        <SwitchRow
          onValueChange={(weekendShading) => update({ weekendShading })}
          switchTestID="weekend-shading"
          title="Shade Weekends"
          value={shading}
        />
      </Section>
      <Section header="Weekend Days">
        {WEEKDAY_OPTIONS.map((option) => {
          const checked = days.includes(option.value);
          return (
            <CheckRow
              checked={checked}
              disabled={!shading}
              key={option.value}
              kind="checkbox"
              onPress={() => toggle(option.value)}
              testID={`weekend-day-${option.value}${checked ? '-on' : ''}`}
              title={option.label}
            />
          );
        })}
      </Section>
    </SettingsPage>
  );
}
