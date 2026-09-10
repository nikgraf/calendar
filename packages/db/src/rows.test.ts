import { describe, expect, it } from 'vitest';
import { eventFromRow, type EventRow, pendingOpFromRow, type PendingOpRow } from './rows.ts';

const eventRow = (overrides: Partial<EventRow> = {}): EventRow => ({
  account_id: 'acc-1',
  attendees: null,
  calendar_id: 'cal-1',
  description: null,
  end_date: null,
  end_utc: 2000,
  etag: null,
  hangout_link: null,
  id: 'evt',
  is_all_day: 0,
  location: null,
  organizer_email: null,
  original_start_utc: null,
  recurrence: null,
  recurring_event_id: null,
  start_date: null,
  start_time_zone: null,
  start_utc: 1000,
  status: 'confirmed',
  sync_status: 'synced',
  synced_at: 0,
  title: 'x',
  updated_at: 0,
  ...overrides,
});

const opRow = (overrides: Partial<PendingOpRow> = {}): PendingOpRow => ({
  account_id: 'acc-1',
  attempts: 0,
  attendees_changed: 0,
  base_etag: null,
  calendar_id: 'cal-1',
  color_hex: null,
  created_at: 0,
  dispatched_at: null,
  event_id: 'evt',
  id: 'op',
  kind: 'update',
  last_error: null,
  next_attempt_at: 0,
  payload: null,
  task_due: null,
  task_list_id: null,
  task_notes: null,
  task_status: null,
  task_title: null,
  ...overrides,
});

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

  it('pendingOpFromRow turns an unreadable payload into payload: undefined', () => {
    const op = pendingOpFromRow(opRow({ payload: '{"id": 1}' }));
    expect(op?.kind).toBe('update');
    expect(op?.payload).toBeUndefined();
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
