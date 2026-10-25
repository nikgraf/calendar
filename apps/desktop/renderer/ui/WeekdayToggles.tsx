import { WEEKDAY_OPTIONS } from '@calendar/app-state';
import type { Weekday } from '@calendar/core';

const toggle = (active: boolean) =>
  `flex-1 rounded-md px-1 py-1 text-xs font-medium disabled:cursor-default disabled:opacity-50 ${
    active ? 'bg-primary text-on-primary' : 'text-ink-secondary enabled:hover:bg-fill'
  }`;

/**
 * A Monday-first row of day buttons, each pressed or not: a weekly repeat
 * rule's days and the weekend's. Each button's test id is
 * `<testIdPrefix>-<code>` ("repeat-weekday-MO").
 */
export function WeekdayToggles({
  disabled = false,
  label,
  onToggle,
  selected,
  testIdPrefix,
}: {
  disabled?: boolean;
  /** The group's accessible name. */
  label: string;
  onToggle: (weekday: Weekday) => void;
  selected: ReadonlyArray<Weekday>;
  testIdPrefix: string;
}) {
  return (
    <div
      aria-label={label}
      className="flex gap-1 rounded-lg border border-hairline bg-fill p-1"
      role="group"
    >
      {WEEKDAY_OPTIONS.map((option) => {
        const pressed = selected.includes(option.value);
        return (
          <button
            aria-label={option.label}
            aria-pressed={pressed}
            className={toggle(pressed)}
            data-testid={`${testIdPrefix}-${option.value}`}
            disabled={disabled}
            key={option.value}
            onClick={() => onToggle(option.value)}
            type="button"
          >
            {option.short}
          </button>
        );
      })}
    </div>
  );
}
