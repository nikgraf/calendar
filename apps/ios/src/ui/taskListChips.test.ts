import { describe, expect, it } from 'vite-plus/test';
import { taskListChips } from './taskListChips.ts';

const google = { accountId: 'g', id: 'inbox', isVisible: true, title: 'My Tasks' };
const work = { accountId: 'g', id: 'work', isVisible: true, title: 'Work' };
const reminders = { accountId: 'apple-reminders', id: 'r', isVisible: true, title: 'Reminders' };

describe('taskListChips', () => {
  it('offers All plus one chip per visible list', () => {
    const { active, chips } = taskListChips([google, reminders], 'apple-reminders:r');
    expect(chips).toEqual([
      { id: null, label: 'All' },
      { id: 'g:inbox', label: 'My Tasks' },
      { id: 'apple-reminders:r', label: 'Reminders' },
    ]);
    expect(active).toBe('apple-reminders:r');
  });

  it('leaves hidden lists out, and shows no row with one visible list', () => {
    const hidden = { ...work, isVisible: false };
    expect(taskListChips([google, hidden, reminders], null).chips.map((chip) => chip.id)).toEqual([
      null,
      'g:inbox',
      'apple-reminders:r',
    ]);
    expect(taskListChips([google, hidden], null).chips).toEqual([]);
  });

  it('falls back to All once the selected list is gone or hidden', () => {
    // Reminders disconnected: one list left, so the row is gone too.
    expect(taskListChips([google], 'apple-reminders:r')).toEqual({ active: null, chips: [] });
    expect(
      taskListChips([google, work, { ...reminders, isVisible: false }], 'apple-reminders:r').active,
    ).toBeNull();
  });

  it('tells lists with the same id in different accounts apart', () => {
    const other = { ...google, accountId: 'h', title: 'Other' };
    expect(taskListChips([google, other], 'h:inbox').active).toBe('h:inbox');
    expect(taskListChips([google, work], 'h:inbox').active).toBeNull();
  });
});
