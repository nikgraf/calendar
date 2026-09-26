import { Temporal, TaskRecord, validateEventDraft } from '@calendar/core';
import { describe, expect, it } from 'vitest';
import { seedTimeFields } from './editorModel.ts';
import { seedDueTiming } from './taskEditorModel.ts';

const initialDate = Temporal.PlainDate.from('2026-09-16');

describe('seedTimeFields', () => {
  it('opens a drawn slot with its own start and end', () => {
    expect(
      seedTimeFields({ initialDate, initialTimes: { endTime: '11:30', startTime: '10:00' } }),
    ).toEqual({ endTime: '11:30', startTime: '10:00' });
  });

  it('keeps the clicked hour, one hour long, when no slot was drawn', () => {
    expect(seedTimeFields({ initialDate, initialHour: 14 })).toEqual({
      endTime: '15:00',
      startTime: '14:00',
    });
    expect(seedTimeFields({ initialDate })).toEqual({ endTime: '10:00', startTime: '09:00' });
  });

  it('ends a click on the last hour at 23:59, which the draft accepts', () => {
    const times = seedTimeFields({ initialDate, initialHour: 23 });
    expect(times).toEqual({ endTime: '23:59', startTime: '23:00' });
    const fields = { calendarKey: 'acc-1:cal-1', date: '2026-09-16', isAllDay: false };
    expect(validateEventDraft({ ...fields, ...times, title: 'Late call' }, 'UTC')).toBeNull();
    // `24:00` is no time the draft accepts.
    expect(
      validateEventDraft(
        { ...fields, endTime: '24:00', startTime: '23:00', title: 'Late call' },
        'UTC',
      ),
    ).toBe('That date or time is not valid.');
  });

  it('lets a quick-add result win over a slot', () => {
    expect(
      seedTimeFields({
        initialDate,
        initialTimes: { endTime: '11:30', startTime: '10:00' },
        prefill: {
          date: '2026-09-16',
          endTime: '13:00',
          isAllDay: false,
          startTime: '12:00',
          title: 'Lunch',
        },
      }),
    ).toEqual({ endTime: '13:00', startTime: '12:00' });
  });
});

describe('seedDueTiming', () => {
  it('starts a new task timed at the slot start', () => {
    expect(seedDueTiming({ initialDate: '2026-09-16', initialTime: '10:00' })).toEqual({
      dueTime: '10:00',
      timed: true,
    });
  });

  it('starts an untimed 09:00 default without a slot', () => {
    expect(seedDueTiming({ initialDate: '2026-09-16' })).toEqual({
      dueTime: '09:00',
      timed: false,
    });
  });

  it("keeps an existing task's own timing, ignoring the slot", () => {
    const existing = new TaskRecord({
      accountId: 'acc',
      dueDate: '2026-09-16',
      id: 'task',
      listId: 'list',
      provider: 'apple',
      status: 'needsAction',
      title: 'Untimed reminder',
      updatedAt: 1,
    });
    expect(seedDueTiming({ existing, initialDate: '2026-09-16', initialTime: '10:00' })).toEqual({
      dueTime: '09:00',
      timed: false,
    });
  });
});
