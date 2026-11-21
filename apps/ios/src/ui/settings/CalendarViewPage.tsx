import { useDefaultCalendarEditor, useWeekendEditor, WEEKDAY_OPTIONS } from '@calendar/app-state';
import { CheckRow, NavRow, Section, SettingsPage, SwitchRow } from '../GroupedList.tsx';
import { defaultCalendarValue } from './DefaultCalendarPage.tsx';

/**
 * The calendar's own settings: where new events start (the default
 * calendar, picked on its own page), which days are the weekend and
 * whether the grids shade them. All of it travels in the settings file.
 */
export function CalendarViewPage() {
  const weekend = useWeekendEditor();
  const defaultCalendar = useDefaultCalendarEditor();
  if (!weekend || !defaultCalendar) {
    return <SettingsPage testID="settings-page-calendar-view">{null}</SettingsPage>;
  }
  return (
    <SettingsPage testID="settings-page-calendar-view">
      <Section header="New Events">
        <NavRow
          href="/settings/default-calendar"
          testID="settings-row-default-calendar"
          title="Default Calendar"
          value={defaultCalendarValue(defaultCalendar)}
          valueTestID="settings-default-calendar-value"
        />
      </Section>
      <Section
        footer="Weekend days get a light background in Day, 2 Days, Week and Month."
        header="Weekends"
      >
        <SwitchRow
          onValueChange={weekend.setShading}
          switchTestID="weekend-shading"
          title="Shade Weekends"
          value={weekend.shading}
        />
      </Section>
      <Section header="Weekend Days">
        {WEEKDAY_OPTIONS.map((option) => {
          const checked = weekend.days.includes(option.value);
          return (
            <CheckRow
              checked={checked}
              disabled={!weekend.shading}
              key={option.value}
              kind="checkbox"
              onPress={() => weekend.toggleDay(option.value)}
              testID={`weekend-day-${option.value}${checked ? '-on' : ''}`}
              title={option.label}
            />
          );
        })}
      </Section>
    </SettingsPage>
  );
}
