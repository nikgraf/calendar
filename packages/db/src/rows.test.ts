import { describe, expect, it } from 'vite-plus/test';
import { CarriedText, EventReminders, GeoLocation, ReminderOverride } from '@calendar/core';
import { eventPayloadJson } from './repoShared.ts';
import {
  eventFromRow,
  type EventRow,
  eventToRow,
  pendingOpFromRow,
  type PendingOpRow,
} from './rows.ts';

const eventRow = (overrides: Partial<EventRow> = {}): EventRow => ({
  account_id: 'acc-1',
  attendees: null,
  calendar_id: 'cal-1',
  description: null,
  end_date: null,
  end_utc: 2000,
  etag: null,
  geo: null,
  hangout_link: null,
  id: 'evt',
  is_all_day: 0,
  location: null,
  mirror: null,
  organizer_email: null,
  original_start_utc: null,
  recurrence: null,
  recurrence_end_utc: null,
  recurring_event_id: null,
  reminders: null,
  start_date: null,
  start_time_zone: null,
  start_utc: 1000,
  status: 'confirmed',
  sync_status: 'synced',
  synced_at: 0,
  title: 'x',
  transparency: null,
  updated_at: 0,
  visibility: null,
  ...overrides,
});

const eventRow2 = (reminders: EventReminders) => ({ ...eventFromRow(eventRow()), reminders });

const opRow = (overrides: Partial<PendingOpRow> = {}): PendingOpRow => ({
  account_id: 'acc-1',
  attempts: 0,
  attendees_changed: 0,
  base_etag: null,
  before_color_hex: null,
  before_overrides: null,
  before_payload: null,
  before_task: null,
  calendar_id: 'cal-1',
  carried_text: null,
  color_hex: null,
  conflict_at: null,
  created_at: 0,
  dispatched_at: null,
  event_id: 'evt',
  geo_cleared: 0,
  id: 'op',
  kind: 'update',
  last_error: null,
  next_attempt_at: 0,
  payload: null,
  recurrence_cleared: 0,
  reminders_changed: 0,
  server_payload: null,
  target_calendar_id: null,
  task_due: null,
  task_list_id: null,
  task_notes: null,
  task_status: null,
  task_title: null,
  ...overrides,
});

const master = (recurrence: ReadonlyArray<string> | null) =>
  eventFromRow(
    eventRow({
      end_utc: Date.parse('2026-07-07T10:00:00Z'),
      recurrence: recurrence === null ? null : JSON.stringify(recurrence),
      start_time_zone: 'UTC',
      start_utc: Date.parse('2026-07-07T09:00:00Z'),
    }),
  );

describe('row decoders tolerate what the DB may hold', () => {
  it('eventFromRow degrades bad JSON columns and unknown enums instead of throwing', () => {
    const event = eventFromRow(
      eventRow({
        attendees: '{not json',
        recurrence: '[1, 2]',
        status: 'weird',
        sync_status: 'unknown',
      }),
    );
    expect(event.attendees).toBeUndefined();
    expect(event.recurrence).toBeUndefined();
    expect(event.status).toBe('confirmed');
    expect(event.syncStatus).toBe('synced');
  });

  it('eventFromRow keeps well-formed columns', () => {
    const event = eventFromRow(
      eventRow({
        attendees: JSON.stringify([{ email: 'a@example.com', responseStatus: 'accepted' }]),
        recurrence: JSON.stringify(['RRULE:FREQ=DAILY']),
        status: 'tentative',
        sync_status: 'pending',
      }),
    );
    expect(event.attendees?.[0]?.email).toBe('a@example.com');
    expect(event.recurrence).toEqual(['RRULE:FREQ=DAILY']);
    expect(event.status).toBe('tentative');
    expect(event.syncStatus).toBe('pending');
  });

  it('eventToRow stores when a series ends: NULL for endless series and singles', () => {
    expect(eventToRow(master(['RRULE:FREQ=WEEKLY;COUNT=2'])).recurrence_end_utc).toBe(
      Date.parse('2026-07-14T10:00:00Z'),
    );
    expect(eventToRow(master(['RDATE:20260901T090000Z'])).recurrence_end_utc).toBe(
      Date.parse('2026-09-01T10:00:00Z'),
    );
    expect(eventToRow(master(['RRULE:FREQ=WEEKLY'])).recurrence_end_utc).toBeNull();
    expect(eventToRow(master(null)).recurrence_end_utc).toBeNull();
  });

  it('eventFromRow round-trips geo and drops an unreadable value', () => {
    const geo = { lat: 48.2, lng: 16.37, name: 'Stephansdom', source: 'Stephansplatz 3, Wien' };
    const event = eventFromRow(eventRow({ geo: JSON.stringify(geo), location: geo.source }));
    expect(event.geo).toEqual(new GeoLocation(geo));
    expect(eventToRow(event).geo).toBe(JSON.stringify(geo));
    expect(eventFromRow(eventRow({ geo: '{"lat":"north"}' })).geo).toBeUndefined();
  });

  it('eventFromRow round-trips reminders, keeps "none" apart from absent and drops junk', () => {
    const none = new EventReminders({ overrides: [], useDefault: false });
    expect(eventFromRow(eventRow({ reminders: JSON.stringify(none) })).reminders).toEqual(none);
    const custom = new EventReminders({
      overrides: [new ReminderOverride({ method: 'popup', minutes: 30 })],
      useDefault: false,
    });
    const event = eventFromRow(eventRow({ reminders: eventToRow(eventRow2(custom)).reminders }));
    expect(event.reminders).toEqual(custom);
    expect(eventFromRow(eventRow()).reminders).toBeUndefined();
    expect(eventFromRow(eventRow({ reminders: '{"useDefault":"yes"}' })).reminders).toBeUndefined();
  });

  it('pendingOpFromRow turns an unreadable payload into payload: undefined', () => {
    const op = pendingOpFromRow(opRow({ payload: '{"id": 1}' }));
    expect(op?.kind).toBe('update');
    expect(op?.payload).toBeUndefined();
  });

  it('pendingOpFromRow reads carriedText and drops an unreadable one', () => {
    const carried = {
      base: { description: null, location: 'Room 1', title: 'Daily' },
      overrides: [
        { etag: null, eventId: 'evt_20300101T090000Z', location: null, title: 'Daily (moved)' },
      ],
    };
    expect(pendingOpFromRow(opRow({ carried_text: JSON.stringify(carried) }))?.carriedText).toEqual(
      new CarriedText(carried),
    );
    expect(pendingOpFromRow(opRow({ carried_text: '{"base":1}' }))?.carriedText).toBeUndefined();
    expect(pendingOpFromRow(opRow())?.carriedText).toBeUndefined();
  });

  it('pendingOpFromRow keeps the three states of before_payload apart', () => {
    // SQL NULL: an op from before the column — nothing to put back.
    expect(pendingOpFromRow(opRow())?.beforePayload).toBeUndefined();
    // The JSON text null: there was no row before the change.
    expect(pendingOpFromRow(opRow({ before_payload: 'null' }))?.beforePayload).toBeNull();
    const before = eventFromRow(eventRow({ title: 'Before' }));
    expect(
      pendingOpFromRow(opRow({ before_payload: JSON.stringify(eventPayloadJson(before)) }))
        ?.beforePayload?.title,
    ).toBe('Before');
    // Unreadable JSON degrades like every other JSON column.
    expect(pendingOpFromRow(opRow({ before_payload: '{not json' }))?.beforePayload).toBeUndefined();
    expect(pendingOpFromRow(opRow({ before_task: '{"id": 1}' }))?.beforeTask).toBeUndefined();
    expect(pendingOpFromRow(opRow({ before_overrides: '[1]' }))?.beforeOverrides).toBeUndefined();
  });

  it('pendingOpFromRow skips a row whose op kind nothing could apply', () => {
    expect(pendingOpFromRow(opRow({ kind: 'teleport' }))).toBeUndefined();
  });

  it('pendingOpFromRow drops an unknown task status rather than carrying it', () => {
    expect(
      pendingOpFromRow(opRow({ kind: 'completeTask', task_status: 'maybe' }))?.taskStatus,
    ).toBeUndefined();
  });
});
