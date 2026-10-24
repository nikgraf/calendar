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
import { FIELD_CLASS, LABEL_CLASS } from '../ui/fieldStyles.ts';
import { WeekdayToggles } from '../ui/WeekdayToggles.tsx';
import { FormSection } from './FormSection.tsx';
import { useFieldFlash } from '../ui/useFlash.ts';

/** The repeat form state both editors expose (everything but the spec exit). */
export type RepeatRuleState = Omit<ReturnType<typeof useRepeatState>, 'toSpec'>;

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
  const flash = useFieldFlash<HTMLSelectElement>('repeat');
  return (
    <FormSection label="Repeat">
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <select
            aria-label="Repeat"
            className={FIELD_CLASS}
            onChange={(input) =>
              state.setRepeat(input.target.value as RecurrenceFrequency | 'none')
            }
            ref={flash}
            value={state.repeat}
          >
            {REPEAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
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
        <WeekdayToggles
          label="Repeat on"
          onToggle={state.toggleWeekday}
          selected={state.repeatWeekdays}
          testIdPrefix="repeat-weekday"
        />
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
                min={anchorDate}
                onChange={(input) => state.setRepeatUntil(input.target.value)}
                type="date"
                value={state.repeatUntil}
              />
            </label>
          ) : null}
        </div>
      )}
      {state.repeatSummary ? (
        <p className="text-xs text-ink-secondary" data-testid="repeat-summary">
          {state.repeatSummary}
        </p>
      ) : null}
    </FormSection>
  );
}
