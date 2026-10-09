import { EventRecord, type ParkedOpSummary } from '@calendar/core';
import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * Just enough of React's hook runtime to run `useConflictAnnouncement`
 * render after render: slots by call order, an effect that runs when its
 * dependencies change, an effect event that is the function itself.
 */
const react = vi.hoisted(() => {
  let slots: Array<unknown> = [];
  let index = 0;
  return {
    render: <T>(run: () => T): T => {
      index = 0;
      return run();
    },
    reset: () => {
      slots = [];
    },
    useEffect: (effect: () => void, deps: ReadonlyArray<unknown>) => {
      const slot = index++;
      const previous = slots[slot] as ReadonlyArray<unknown> | undefined;
      if (!previous || deps.some((dep, at) => dep !== previous[at])) {
        slots[slot] = deps;
        effect();
      }
    },
    useEffectEvent: <F>(callback: F): F => callback,
    useRef: <T>(initial: T): { current: T } => {
      const slot = index++;
      if (!(slot in slots)) {
        slots[slot] = { current: initial };
      }
      return slots[slot] as { current: T };
    },
    useState: <T>(initial: T) => [initial, () => {}] as const,
  };
});
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: react.useEffect,
  useEffectEvent: react.useEffectEvent,
  useRef: react.useRef,
  useState: react.useState,
}));

const { conflictAnnouncement, freshConflicts, mutationNoticeText, useConflictAnnouncement } =
  await import('./notices.ts');

const TZ = 'Europe/Vienna';

const event = (title: string) =>
  new EventRecord({
    accountId: 'a',
    calendarId: 'c',
    endUtc: Date.parse('2026-09-22T08:00:00Z'),
    etag: null,
    id: `e-${title}`,
    isAllDay: false,
    startUtc: Date.parse('2026-09-22T07:00:00Z'),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'pending',
    title,
    updatedAt: 0,
  });

const parked = (id: string, title: string): ParkedOpSummary => ({
  accountId: 'a',
  attempts: 0,
  calendarId: 'c',
  conflict: { at: 1, mine: event(title), theirs: event(`${title} (Google)`) },
  createdAt: 1,
  eventId: `e-${title}`,
  id,
  kind: 'update',
  nextAttemptAt: 0,
  title,
});

describe('freshConflicts', () => {
  it('returns what is new and remembers only what is still parked', () => {
    const budget = parked('op-1', 'Budget');
    const offsite = parked('op-2', 'Offsite');
    const first = freshConflicts(new Set(), [budget]);
    expect(first.fresh).toEqual([budget]);

    const second = freshConflicts(first.told, [budget, offsite]);
    expect(second.fresh).toEqual([offsite]);

    // Budget resolved: forgotten, so the set stays the size of the queue.
    const third = freshConflicts(second.told, [offsite]);
    expect(third.fresh).toEqual([]);
    expect([...third.told]).toEqual(['op-2']);
  });
});

describe('conflictAnnouncement', () => {
  it('reads the first new change the way the banner words it', () => {
    expect(conflictAnnouncement([parked('op-1', 'Budget')], TZ)).toBe(
      'Sync conflict: “Budget” changed on Google while your edit waited.',
    );
  });

  it('counts the others that parked with it', () => {
    const three = [parked('op-1', 'Budget'), parked('op-2', 'Offsite'), parked('op-3', 'Lunch')];
    expect(conflictAnnouncement(three.slice(0, 2), TZ)).toBe(
      'Sync conflict: “Budget” changed on Google while your edit waited. 1 more change also conflicts.',
    );
    expect(conflictAnnouncement(three, TZ)).toMatch(/ 2 more changes also conflict\.$/);
  });

  it('has nothing to say when nothing is new', () => {
    expect(conflictAnnouncement([], TZ)).toBeUndefined();
  });
});

describe('useConflictAnnouncement', () => {
  it('announces each parked change once, however often the queue re-renders', () => {
    react.reset();
    const heard: Array<string> = [];
    const render = (queue: ReadonlyArray<ParkedOpSummary>) =>
      react.render(() => useConflictAnnouncement(queue, TZ, (text) => heard.push(text)));
    const budget = parked('op-1', 'Budget');
    const offsite = parked('op-2', 'Offsite');

    // Already parked when the banner mounts: told once.
    render([budget]);
    expect(heard).toEqual(['Sync conflict: “Budget” changed on Google while your edit waited.']);
    // A re-render with an equal queue (a new array) says nothing.
    render([{ ...budget }]);
    expect(heard).toHaveLength(1);
    // A second change parks: only it is told.
    render([budget, offsite]);
    expect(heard.at(-1)).toBe('Sync conflict: “Offsite” changed on Google while your edit waited.');
    // Resolving one is not news.
    render([offsite]);
    render([]);
    expect(heard).toHaveLength(2);
    // The same event parking again later is a new conflict.
    render([parked('op-3', 'Budget')]);
    expect(heard).toHaveLength(3);
  });
});

describe('mutationNoticeText', () => {
  it('says what failed and that nothing changed', () => {
    expect(mutationNoticeText({ action: 'reschedule the event', detail: '' })).toBe(
      'Couldn’t reschedule the event — the change was not applied.',
    );
  });
});
