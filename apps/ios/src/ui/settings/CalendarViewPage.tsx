import { useWeekendEditor, WEEKDAY_OPTIONS } from '@calendar/app-state';
import { CheckRow, Section, SettingsPage, SwitchRow } from '../GroupedList.tsx';

/**
 * How the calendar is drawn: which days are the weekend, and whether the
 * grids shade them. A view preference that travels in the settings file.
 */
export function CalendarViewPage() {
  const weekend = useWeekendEditor();
  if (!weekend) {
    return <SettingsPage testID="settings-page-calendar-view">{null}</SettingsPage>;
  }
  return (
    <SettingsPage testID="settings-page-calendar-view">
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
