import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  GcalCalendarListPage,
  GcalEvent,
  GcalEventsPage,
  GcalPeoplePage,
  GcalTask,
  GcalTasksPage,
} from './apiTypes.ts';

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value);

/**
 * The wire schemas are deliberately loose: Google adds fields, omits
 * optional ones per item, and sends tombstones with almost nothing. Each
 * case here is a payload shape seen in the API docs or in the wild.
 */
describe('Google API schemas tolerate real payloads', () => {
  it('decodes an event with fields we never model and without optional ones', () => {
    const event = decode(GcalEvent, {
      created: '2026-07-01T10:00:00.000Z',
      creator: { email: 'a@example.com' },
      end: { dateTime: '2026-07-02T13:00:00+02:00' },
      eventType: 'default',
      htmlLink: 'https://calendar.google.com/x',
      iCalUID: 'x@google.com',
      id: 'evt-1',
      kind: 'calendar#event',
      reminders: { useDefault: true },
      sequence: 0,
      start: { dateTime: '2026-07-02T12:00:00+02:00', timeZone: 'Europe/Vienna' },
      status: 'confirmed',
      summary: 'Lunch',
    });
    expect(event.id).toBe('evt-1');
    expect(event.start?.timeZone).toBe('Europe/Vienna');
    expect(event.attendees).toBeUndefined();
  });

  it('decodes a cancelled tombstone that carries only id and status', () => {
    const page = decode(GcalEventsPage, {
      items: [{ id: 'gone', status: 'cancelled' }],
      nextSyncToken: 'tok',
    });
    expect(page.items?.[0]?.status).toBe('cancelled');
    expect(page.items?.[0]?.start).toBeUndefined();
  });

  it('rejects an event without an id', () => {
    expect(() => decode(GcalEvent, { summary: 'no id' })).toThrow();
  });

  it('decodes calendarList entries with and without colors and summaries', () => {
    const page = decode(GcalCalendarListPage, {
      items: [
        { accessRole: 'owner', backgroundColor: '#9fe1e7', id: 'primary', primary: true },
        { deleted: true, id: 'old' },
      ],
    });
    expect(page.items).toHaveLength(2);
    expect(page.items?.[1]?.deleted).toBe(true);
  });

  it('decodes tasks: a full task, a bare deleted one, and hidden completed ones', () => {
    const page = decode(GcalTasksPage, {
      items: [
        {
          due: '2026-08-30T00:00:00.000Z',
          id: 't1',
          kind: 'tasks#task',
          links: [],
          position: '00000000000000000001',
          selfLink: 'https://tasks.googleapis.com/x',
          status: 'needsAction',
          title: 'Pay rent',
          updated: '2026-08-20T00:00:00.000Z',
        },
        { deleted: true, id: 't2', updated: '2026-08-21T00:00:00.000Z' },
        { completed: '2026-08-22T09:00:00.000Z', hidden: true, id: 't3', status: 'completed' },
      ],
    });
    expect(page.items?.map((task) => task.id)).toEqual(['t1', 't2', 't3']);
    expect(decode(GcalTask, { id: 'only-id' }).title).toBeUndefined();
  });

  it('decodes People pages for both tiers, including deleted tombstones', () => {
    const page = decode(GcalPeoplePage, {
      connections: [
        {
          emailAddresses: [{ metadata: { primary: true }, value: 'a@example.com' }],
          names: [{ displayName: 'A', metadata: { primary: true } }],
          resourceName: 'people/1',
        },
        { metadata: { deleted: true }, resourceName: 'people/2' },
      ],
      nextSyncToken: 'people-tok',
      totalItems: 2,
      totalPeople: 2,
    });
    expect(page.connections?.map((person) => person.resourceName)).toEqual([
      'people/1',
      'people/2',
    ]);
    expect(page.otherContacts).toBeUndefined();
  });
});
