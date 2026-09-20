import {
  MONTHLY_MODE_OPTIONS,
  ORDINAL_OPTIONS,
  REPEAT_ENDS_OPTIONS,
  REPEAT_OPTIONS,
  type useRepeatState,
  WEEKDAY_OPTIONS,
} from '@calendar/app-state';
import {
  type MonthlyOrdinal,
  type RecurrenceFrequency,
  Temporal,
  type Weekday,
} from '@calendar/core';
import { FIELD_CLASS, LABEL_CLASS } from './taskEditorOptions.ts';

/** The repeat form state both editors expose (everything but the spec exit). */
export type RepeatRuleState = Omit<ReturnType<typeof useRepeatState>, 'toSpec'>;

const toggle = (active: boolean) =>
  `flex-1 rounded-md px-1 py-1 text-xs font-medium ${
    active ? 'bg-blue-600 text-white' : 'text-neutral-600 hover:bg-neutral-200/60'
  }`;

/** "Day 14" for the anchor date, or a neutral label while the date field is mid-edit. */
const dayOfMonthLabel = (anchorDate: string): string => {
  try {
    return `Day ${String(Temporal.PlainDate.from(anchorDate).day)}`;
  } catch {
    return 'Day of the month';
  }
};

/**
 * The repeat rule controls shared by the event and the reminder editor:
 * frequency and interval, the weekday toggles of a weekly rule, the "day
 * of the month" / "Nth weekday" choice of a monthly rule, the end
 * condition, and a summary in Reminders.app's words. The aria-labels are
 * the e2e suite's handles.
 */
export function RepeatRuleFields({
  anchorDate,
  state,
}: {
  /** The due/start date: seeds "until" and names the monthly day. */
  anchorDate: string;
  state: RepeatRuleState;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        <label className={`${LABEL_CLASS} flex-1`}>
          Repeat
          <select
            aria-label="Repeat"
            className={`${FIELD_CLASS} mt-1`}
            onChange={(input) =>
              state.setRepeat(input.target.value as RecurrenceFrequency | 'none')
            }
            value={state.repeat}
          >
            {REPEAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {state.repeat === 'none' ? null : (
          <label className={`${LABEL_CLASS} w-24`}>
            Every (n)
            <input
              aria-label="Repeat interval"
              className={`${FIELD_CLASS} mt-1`}
              min={1}
              onChange={(input) => state.setRepeatInterval(input.target.value)}
              type="number"
              value={state.repeatInterval}
            />
          </label>
        )}
      </div>
      {state.repeat === 'weekly' ? (
        <div
          aria-label="Repeat on"
          className="flex gap-1 rounded-lg border border-neutral-200 bg-neutral-100 p-1"
          role="group"
        >
          {WEEKDAY_OPTIONS.map((option) => {
            const pressed = state.repeatWeekdays.includes(option.value);
            return (
              <button
                aria-label={option.label}
                aria-pressed={pressed}
                className={toggle(pressed)}
                data-testid={`repeat-weekday-${option.value}`}
                key={option.value}
                onClick={() => state.toggleWeekday(option.value)}
                type="button"
              >
                {option.short}
              </button>
            );
          })}
        </div>
      ) : null}
      {state.repeat === 'monthly' ? (
        <div className="flex gap-3">
          <label className={`${LABEL_CLASS} flex-1`}>
            Monthly on
            <select
              aria-label="Monthly on"
              className={`${FIELD_CLASS} mt-1`}
              onChange={(input) =>
                state.setRepeatMonthly(input.target.value as 'dayOfMonth' | 'weekday')
              }
              value={state.repeatMonthly}
            >
              {MONTHLY_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === 'dayOfMonth' ? dayOfMonthLabel(anchorDate) : 'A weekday'}
                </option>
              ))}
            </select>
          </label>
          {state.repeatMonthly === 'weekday' ? (
            <>
              <label className={`${LABEL_CLASS} w-20`}>
                Which
                <select
                  aria-label="Ordinal"
                  className={`${FIELD_CLASS} mt-1`}
                  onChange={(input) =>
                    state.setRepeatOrdinal(Number(input.target.value) as MonthlyOrdinal)
                  }
                  value={String(state.repeatOrdinal)}
                >
                  {ORDINAL_OPTIONS.map((option) => (
                    <option key={option.value} value={String(option.value)}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`${LABEL_CLASS} flex-1`}>
                Weekday
                <select
                  aria-label="Ordinal weekday"
                  className={`${FIELD_CLASS} mt-1`}
                  onChange={(input) => state.setRepeatOrdinalWeekday(input.target.value as Weekday)}
                  value={state.repeatOrdinalWeekday}
                >
                  {WEEKDAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
        </div>
      ) : null}
      {state.repeat === 'none' ? null : (
        <div className="flex gap-3">
          <label className={`${LABEL_CLASS} flex-1`}>
            Ends
            <select
              aria-label="Repeat ends"
              className={`${FIELD_CLASS} mt-1`}
              onChange={(input) => {
                const value = input.target.value as 'after' | 'never' | 'on';
                state.setRepeatEnds(value);
                if (value === 'on' && !state.repeatUntil) {
                  state.setRepeatUntil(anchorDate);
                }
              }}
              value={state.repeatEnds}
            >
              {REPEAT_ENDS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {state.repeatEnds === 'after' ? (
            <label className={`${LABEL_CLASS} w-24`}>
              Times
              <input
                aria-label="Occurrence count"
                className={`${FIELD_CLASS} mt-1`}
                min={1}
                onChange={(input) => state.setRepeatCount(input.target.value)}
                type="number"
                value={state.repeatCount}
              />
            </label>
          ) : null}
          {state.repeatEnds === 'on' ? (
            <label className={`${LABEL_CLASS} flex-1`}>
              Until
              <input
                aria-label="Repeat until"
                className={`${FIELD_CLASS} mt-1`}
                onChange={(input) => state.setRepeatUntil(input.target.value)}
                type="date"
                value={state.repeatUntil}
              />
            </label>
          ) : null}
        </div>
      )}
      {state.repeatSummary ? (
        <p className="text-xs text-neutral-500" data-testid="repeat-summary">
          {state.repeatSummary}
        </p>
      ) : null}
    </div>
  );
}
