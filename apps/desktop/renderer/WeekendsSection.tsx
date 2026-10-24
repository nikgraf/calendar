import { useUpdateViewPreferences, useViewPreferences } from '@calendar/app-state';
import { DEFAULT_WEEKEND_DAYS, sortWeekdays, type Weekday } from '@calendar/core';
import { WeekdayToggles } from './ui/WeekdayToggles.tsx';

/**
 * Which days the grids draw as the weekend, and whether they shade them at
 * all. A view preference that travels in the settings file, like the
 * all-day lane cap. Written through `useUpdateViewPreferences` rather than
 * a settings editor: the calendar window writes the same struct (opening
 * view, sidebar), so each change merges onto the latest stored value.
 */
export function WeekendsSection() {
  const preferences = useViewPreferences();
  const update = useUpdateViewPreferences();

  if (!preferences) {
    return null;
  }
  const shading = preferences.weekendShading ?? true;
  const days = preferences.weekendDays ?? DEFAULT_WEEKEND_DAYS;
  const toggleDay = (day: Weekday) =>
    update({
      weekendDays: sortWeekdays(
        days.includes(day) ? days.filter((other) => other !== day) : [...days, day],
      ),
    });

  return (
    <section className="rounded-popover bg-surface-subtle p-4" data-testid="weekends">
      <h2 className="font-medium">Weekends</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        Weekend days get a light background in Day, Week and Month.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          aria-label="Shade weekends"
          checked={shading}
          onChange={(change) => update({ weekendShading: change.target.checked })}
          type="checkbox"
        />
        Shade weekends
      </label>
      <div className="mt-3">
        <WeekdayToggles
          disabled={!shading}
          label="Weekend days"
          onToggle={toggleDay}
          selected={days}
          testIdPrefix="weekend-day"
        />
      </div>
    </section>
  );
}
