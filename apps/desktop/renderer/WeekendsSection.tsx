import { useWeekendEditor } from '@calendar/app-state';
import { WeekdayToggles } from './ui/WeekdayToggles.tsx';

/**
 * Which days the grids draw as the weekend, and whether they shade them at
 * all. A view preference that travels in the settings file, like the
 * all-day lane cap; `useWeekendEditor` keeps quick changes from
 * overwriting each other.
 */
export function WeekendsSection() {
  const weekend = useWeekendEditor();

  if (!weekend) {
    return null;
  }

  return (
    <section className="rounded-popover bg-surface-subtle p-4" data-testid="weekends">
      <h2 className="font-medium">Weekends</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        Weekend days get a light background in Day, Week and Month.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          aria-label="Shade weekends"
          checked={weekend.shading}
          onChange={(change) => weekend.setShading(change.target.checked)}
          type="checkbox"
        />
        Shade weekends
      </label>
      <div className="mt-3">
        <WeekdayToggles
          disabled={!weekend.shading}
          label="Weekend days"
          onToggle={weekend.toggleDay}
          selected={weekend.days}
          testIdPrefix="weekend-day"
        />
      </div>
    </section>
  );
}
