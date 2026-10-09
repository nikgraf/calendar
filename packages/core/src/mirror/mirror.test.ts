import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { Temporal } from '../time/temporal.ts';
import { Attendee, EventRecord, TaskRecord } from '../types.ts';
import {
  MIRROR_PRESETS,
  type MirrorDefinition,
  MirrorDefinition as MirrorDefinitionSchema,
  mirrorPresetOf,
  mirrorsIssue,
  normalizeMirror,
  sameMirrorSubstance,
  withMirrorPreset,
} from './definition.ts';
import { type MirrorActual, planMirror } from './diff.ts';
import { googleEventMirrorItem, type MirrorItem, taskMirrorItem } from './item.ts';
import {
  encodeMirrorProperty,
  encodeMirrorUrl,
  googleMirrorMarker,
  isMirrorUrl,
  keyHashOfMirrorEventId,
  mirrorEventId,
  mirrorKeyHash,
  mirrorTag,
  parseMirrorProperty,
  parseMirrorUrl,
  sha256Hex,
} from './marker.ts';
import { buildMirrorCopies, type MirrorCopy } from './transform.ts';
import { mirrorWindow, startsInMirrorWindow } from './window.ts';

const ZONE = 'Europe/Vienna';
const HOUR = 3_600_000;

/** Epoch ms of a wall-clock time in the mirror's zone. */
const at = (date: string, time: string, timeZone = ZONE): number =>
  Temporal.PlainDate.from(date).toZonedDateTime({ plainTime: time, timeZone }).epochMilliseconds;

// "Now" is injected everywhere below, so these dates never decay.
const NOW = at('2026-03-10', '09:00');

const mirror = (overrides: Partial<MirrorDefinition> = {}): MirrorDefinition => ({
  busyLabel: 'Busy',
  destination: {
    calendarId: 'shared@group.calendar.google.com',
    email: 'me@example.com',
    kind: 'google',
  },
  ...MIRROR_PRESETS.titleLocation,
  id: 'mirror-1',
  monthsAhead: 3,
  name: 'Family',
  sources: [{ calendarId: 'work@example.com', email: 'me@example.com', kind: 'google' }],
  timeZone: ZONE,
  updatedAt: 1000,
  ...overrides,
});

const item = (overrides: Partial<MirrorItem> = {}): MirrorItem => ({
  allDay: false,
  declined: false,
  done: false,
  endUtc: at('2026-03-11', '11:00'),
  free: false,
  key: 'g|work@example.com|event-1',
  private: false,
  startUtc: at('2026-03-11', '10:00'),
  title: 'Board meeting',
  ...overrides,
});

const window = mirrorWindow(mirror(), NOW);

describe('mirror definition', () => {
  it('decodes a definition and rejects one outside its limits', () => {
    const decode = Schema.decodeUnknownSync(MirrorDefinitionSchema);
    expect(decode(mirror()).id).toBe('mirror-1');
    expect(() => decode(mirror({ monthsAhead: 25 }))).toThrow();
    expect(() => decode(mirror({ monthsAhead: 0 }))).toThrow();
    expect(() => decode(mirror({ sources: [] }))).toThrow();
    expect(() => decode(mirror({ timeZone: 'Mars/Olympus' }))).toThrow();
    expect(() => decode(mirror({ busyLabel: '' }))).toThrow();
  });

  it('names the preset a definition amounts to', () => {
    expect(mirrorPresetOf(mirror())).toBe('titleLocation');
    expect(mirrorPresetOf(withMirrorPreset(mirror(), 'availability'))).toBe('availability');
    expect(
      mirrorPresetOf(
        mirror({ filters: { ...MIRROR_PRESETS.titleLocation.filters, free: 'skip' } }),
      ),
    ).toBe('custom');
  });

  it('treats source order, repeats, the name and the stamp as the same mirror', () => {
    const a = { calendarId: 'a', email: 'Me@Example.com', kind: 'google' } as const;
    const b = { kind: 'reminders', title: 'Household' } as const;
    const one = mirror({ sources: [a, b] });
    const other = mirror({ name: 'Renamed', sources: [b, a, a], updatedAt: 2000 });
    expect(normalizeMirror(other).sources).toHaveLength(2);
    expect(sameMirrorSubstance(one, other)).toBe(true);
    expect(sameMirrorSubstance(one, mirror({ monthsAhead: 4, sources: [a, b] }))).toBe(false);
  });

  it('refuses two mirrors into one calendar and a destination that is a source', () => {
    expect(mirrorsIssue([mirror()])).toBeUndefined();
    expect(mirrorsIssue([mirror(), mirror({ id: 'mirror-2', name: 'Friends' })])).toContain(
      'same calendar',
    );
    const loop = mirror({
      destination: { kind: 'apple', source: 'iCloud', title: 'Out' },
      id: 'mirror-2',
      name: 'Loop',
      sources: [mirror().destination],
    });
    expect(mirrorsIssue([mirror(), loop])).toContain('cannot also be a source');
  });
});

describe('mirror markers', () => {
  it('hashes with SHA-256', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('derives a Google id that is valid base32hex and salted by the mirror', () => {
    const keyHash = mirrorKeyHash('mirror-1', 'g|cal|event');
    const id = mirrorEventId(keyHash);
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(keyHashOfMirrorEventId(id)).toBe(keyHash);
    expect(mirrorKeyHash('mirror-2', 'g|cal|event')).not.toBe(keyHash);
    expect(keyHashOfMirrorEventId('0123456789abcdefghijklmnop')).toBeUndefined();
  });

  it('round-trips both carriers and ignores anything else', () => {
    const marker = { contentHash: '0123456789abcdef', rev: 1_760_000_000_000, tag: mirrorTag('m') };
    expect(parseMirrorProperty(encodeMirrorProperty(marker))).toEqual(marker);
    const keyHash = mirrorKeyHash('m', 'k');
    expect(parseMirrorUrl(encodeMirrorUrl({ ...marker, keyHash }))).toEqual({ ...marker, keyHash });
    expect(parseMirrorProperty('garbage')).toBeUndefined();
    expect(isMirrorUrl('https://meet.google.com/abc-defg-hij')).toBe(false);
    expect(isMirrorUrl(undefined)).toBe(false);
  });

  it('counts a Google event as a copy only when its id and its property agree', () => {
    const property = encodeMirrorProperty({
      contentHash: '0123456789abcdef',
      rev: 5,
      tag: mirrorTag('m'),
    });
    const id = mirrorEventId(mirrorKeyHash('m', 'k'));
    expect(googleMirrorMarker(id, property)).toBe(property);
    // Someone duplicated a copy: the property came along, the id is new.
    expect(googleMirrorMarker('0123456789abcdefghijklmnop', property)).toBeUndefined();
    expect(googleMirrorMarker(id, undefined)).toBeUndefined();
  });
});

describe('mirror window', () => {
  it('spans a week back and the months ahead, in whole days of the mirror zone', () => {
    expect(window).toMatchObject({
      endDate: '2026-06-10',
      startDate: '2026-03-03',
      today: '2026-03-10',
    });
    expect(window.startUtc).toBe(at('2026-03-03', '00:00'));
    // Another device in another zone computes the same window from the same instant.
    expect(mirrorWindow(mirror(), NOW)).toEqual(window);
  });

  it('places an item by its start alone', () => {
    expect(startsInMirrorWindow(window, item())).toBe(true);
    expect(startsInMirrorWindow(window, item({ startUtc: at('2026-03-02', '23:00') }))).toBe(false);
    expect(
      startsInMirrorWindow(window, { allDay: true, startDate: '2026-06-10', startUtc: 0 }),
    ).toBe(false);
    expect(
      startsInMirrorWindow(window, { allDay: true, startDate: '2026-06-09', startUtc: 0 }),
    ).toBe(true);
  });
});

const task = (overrides: Partial<ConstructorParameters<typeof TaskRecord>[0]> = {}) =>
  new TaskRecord({
    accountId: 'apple-reminders',
    id: 'r1',
    listId: 'household',
    provider: 'apple',
    status: 'needsAction',
    title: 'Clean the filter',
    updatedAt: 1,
    ...overrides,
  });

const event = (overrides: Partial<ConstructorParameters<typeof EventRecord>[0]> = {}) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'work@example.com',
    endUtc: NOW + HOUR,
    etag: null,
    id: 'event-1',
    isAllDay: false,
    startUtc: NOW,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title: 'Board meeting',
    updatedAt: 1,
    visibility: 'default',
    ...overrides,
  });

describe('mirror items', () => {
  it('keys an occurrence by its master and original start', () => {
    expect(googleEventMirrorItem(event(), 'me@example.com').key).toBe('g|work@example.com|event-1');
    const moved = event({
      id: 'master_20260310T080000Z',
      originalStartUtc: 123,
      recurringEventId: 'master',
      startUtc: NOW + 5 * HOUR,
    });
    expect(googleEventMirrorItem(moved, undefined).key).toBe('g|work@example.com|master|123');
  });

  it('reads free, declined and private — and unknown visibility as private', () => {
    const declined = event({
      attendees: [new Attendee({ email: 'me@example.com', responseStatus: 'declined' })],
      transparency: 'transparent',
      visibility: 'private',
    });
    expect(googleEventMirrorItem(declined, 'me@example.com')).toMatchObject({
      declined: true,
      free: true,
      private: true,
    });
    expect(googleEventMirrorItem(event({ visibility: undefined }), undefined).private).toBe(true);
    expect(googleEventMirrorItem(event({ visibility: 'public' }), undefined).private).toBe(false);
  });

  const options = { key: 'r|ext-1', timeZone: ZONE, today: '2026-03-10' };

  it('puts an undated or overdue task on today, all-day', () => {
    expect(taskMirrorItem(task(), options)).toMatchObject({
      allDay: true,
      done: false,
      endDate: '2026-03-11',
      startDate: '2026-03-10',
    });
    expect(taskMirrorItem(task({ dueDate: '2026-03-01' }), options).startDate).toBe('2026-03-10');
  });

  it('keeps a late completion on the day it was completed', () => {
    const done = task({
      completedAt: at('2026-03-09', '18:00'),
      dueDate: '2026-03-01',
      dueTime: '08:00',
      status: 'completed',
    });
    expect(taskMirrorItem(done, options)).toMatchObject({
      allDay: true,
      done: true,
      startDate: '2026-03-09',
    });
  });

  it('reads a reminder with its own zone by its instant, whatever this device’s clock said', () => {
    // 00:30 UTC on the 13th: a Berlin device stores it as the 13th, a New
    // York one as the 12th. The copy must not depend on which device runs.
    const instant = at('2026-03-13', '00:30', 'UTC');
    const berlin = taskMirrorItem(
      { ...task({ dueDate: '2026-03-13', dueTime: '01:30' }), dueUtc: instant } as never,
      options,
    );
    const newYork = taskMirrorItem(
      { ...task({ dueDate: '2026-03-12', dueTime: '19:30' }), dueUtc: instant } as never,
      options,
    );
    expect(newYork).toEqual(berlin);
    expect(berlin).toMatchObject({ allDay: false, startUtc: instant });
  });

  it('makes a timed reminder a short event at its wall-clock time in the mirror zone', () => {
    const timed = taskMirrorItem(task({ dueDate: '2026-03-12', dueTime: '17:30' }), options);
    expect(timed).toMatchObject({ allDay: false, startUtc: at('2026-03-12', '17:30') });
    expect(timed.endUtc - timed.startUtc).toBe(30 * 60_000);
    // A reminder that carries a zone keeps its own instant.
    const instant = at('2026-03-12', '16:30', 'UTC');
    const zoned = taskMirrorItem(
      { ...task({ dueDate: '2026-03-12', dueTime: '17:30' }), dueUtc: instant } as never,
      options,
    );
    expect(zoned.startUtc).toBe(instant);
  });
});

describe('buildMirrorCopies', () => {
  const full = mirror({ ...MIRROR_PRESETS.full });

  it('writes only the fields the definition allows', () => {
    const source = item({
      description: 'Agenda: the acquisition',
      link: 'https://meet.google.com/abc-defg-hij',
      location: 'Room 4',
    });
    const [titleOnly] = buildMirrorCopies(mirror(), [source], window);
    expect(titleOnly).toMatchObject({
      description: undefined,
      location: 'Room 4',
      title: 'Board meeting',
    });
    const [everything] = buildMirrorCopies(full, [source], window);
    expect(everything?.description).toBe(
      'Agenda: the acquisition\n\nhttps://meet.google.com/abc-defg-hij',
    );
    expect(Object.keys(everything!).sort()).toEqual([
      'allDay',
      'contentHash',
      'description',
      'endDate',
      'endUtc',
      'keyHash',
      'location',
      'startDate',
      'startUtc',
      'title',
    ]);
  });

  it('drops a location that is only a join link', () => {
    const [copy] = buildMirrorCopies(
      mirror(),
      [item({ location: 'https://zoom.us/j/123456' })],
      window,
    );
    expect(copy?.location).toBeUndefined();
  });

  it('copies a private event as the busy label with its time only', () => {
    const secret = item({ description: 'x', location: 'y', private: true, title: 'Therapy' });
    const [copy] = buildMirrorCopies(full, [secret], window);
    expect(copy).toMatchObject({ description: undefined, location: undefined, title: 'Busy' });
    const skipping = mirror({ filters: { ...full.filters, private: 'skip' } });
    expect(buildMirrorCopies(skipping, [secret], window)).toEqual([]);
  });

  it('applies the declined, free and all-day filters and the window', () => {
    const allDay = item({
      allDay: true,
      endDate: '2026-03-13',
      key: 'day',
      startDate: '2026-03-12',
      startUtc: at('2026-03-12', '00:00', 'UTC'),
    });
    const items = [
      item({ declined: true, key: 'declined' }),
      item({ free: true, key: 'free' }),
      allDay,
      item({ key: 'far', startUtc: at('2027-03-11', '10:00') }),
    ];
    const availability = withMirrorPreset(mirror(), 'availability');
    expect(buildMirrorCopies(availability, items, window)).toEqual([]);
    // titleLocation copies free and all-day ones, still never a declined one.
    expect(buildMirrorCopies(mirror(), items, window).map((copy) => copy.allDay)).toEqual([
      false,
      true,
    ]);
  });

  it('merges overlapping events into one busy block that names nothing', () => {
    const availability = withMirrorPreset(mirror(), 'availability');
    const copies = buildMirrorCopies(
      availability,
      [
        item({ key: 'a', title: 'Secret one' }),
        item({
          endUtc: at('2026-03-11', '12:00'),
          key: 'b',
          startUtc: at('2026-03-11', '10:30'),
          title: 'Secret two',
        }),
        item({ endUtc: at('2026-03-11', '15:00'), key: 'c', startUtc: at('2026-03-11', '14:00') }),
      ],
      window,
    );
    expect(copies.map((copy) => [copy.title, copy.startUtc, copy.endUtc])).toEqual([
      ['Busy', at('2026-03-11', '10:00'), at('2026-03-11', '12:00')],
      ['Busy', at('2026-03-11', '14:00'), at('2026-03-11', '15:00')],
    ]);
    // The same meeting in two source calendars is one block, whichever comes first.
    const twice = buildMirrorCopies(
      availability,
      [item({ key: 'work' }), item({ key: 'personal' })],
      window,
    );
    expect(twice).toHaveLength(1);
  });

  it('marks a completed task and keeps each identity once', () => {
    const done = item({ done: true, key: 'r|1', title: 'Clean the filter' });
    const copies = buildMirrorCopies(mirror(), [done, done], window);
    expect(copies.map((copy) => copy.title)).toEqual(['✓ Clean the filter']);
  });

  it('gives the same hash for the same copy and another for any shown change', () => {
    const [a] = buildMirrorCopies(mirror(), [item()], window);
    const [b] = buildMirrorCopies(mirror({ updatedAt: 9 }), [item()], window);
    const [c] = buildMirrorCopies(mirror(), [item({ location: 'Room 5' })], window);
    // A hidden field changing changes nothing that was written.
    const [d] = buildMirrorCopies(mirror(), [item({ description: 'new agenda' })], window);
    expect(b?.contentHash).toBe(a?.contentHash);
    expect(d?.contentHash).toBe(a?.contentHash);
    expect(c?.contentHash).not.toBe(a?.contentHash);
  });
});

describe('planMirror', () => {
  const definition = mirror();
  const tag = mirrorTag(definition.id);
  const desired = (...items: Array<MirrorItem>) => buildMirrorCopies(definition, items, window);
  const existing = (
    copy: MirrorCopy,
    overrides: Partial<MirrorActual<string>> = {},
  ): MirrorActual<string> => ({
    allDay: copy.allDay,
    endDate: copy.endDate,
    endUtc: copy.endUtc,
    keyHash: copy.keyHash,
    marker: { contentHash: copy.contentHash, rev: definition.updatedAt, tag },
    order: copy.keyHash,
    ref: copy.keyHash,
    startDate: copy.startDate,
    startUtc: copy.startUtc,
    ...overrides,
  });
  const plan = (copies: ReadonlyArray<MirrorCopy>, actual: ReadonlyArray<MirrorActual<string>>) =>
    planMirror({ actual, desired: copies, nowMs: NOW, rev: definition.updatedAt, tag, window });

  it('creates what is missing, nearest to now first', () => {
    const copies = desired(
      item({ key: 'far', startUtc: at('2026-05-01', '10:00') }),
      item({ key: 'near' }),
    );
    const result = plan(copies, []);
    expect(result.ops.map((op) => op.kind)).toEqual(['create', 'create']);
    expect(result.ops[0]).toMatchObject({ copy: { startUtc: at('2026-03-11', '10:00') } });
  });

  it('writes nothing when every copy is already right', () => {
    const copies = desired(item());
    const result = plan(
      copies,
      copies.map((copy) => existing(copy)),
    );
    expect(result).toMatchObject({ ops: [], present: 1, removals: 0, unchanged: 1 });
  });

  it('updates a copy whose content or time differs and deletes one nobody wants', () => {
    const [copy] = desired(item());
    const stale = existing(copy!, { marker: { contentHash: 'ffffffffffffffff', rev: 1000, tag } });
    expect(plan([copy!], [stale]).ops.map((op) => op.kind)).toEqual(['update']);
    const moved = existing(copy!, { startUtc: copy!.startUtc + HOUR });
    expect(plan([copy!], [moved]).ops.map((op) => op.kind)).toEqual(['update']);
    const gone = plan([], [existing(copy!)]);
    expect(gone.ops.map((op) => op.kind)).toEqual(['delete']);
    expect(gone.removals).toBe(1);
  });

  it('leaves a copy outside the window alone', () => {
    const [copy] = desired(item());
    const old = existing(copy!, { keyHash: 'old', startUtc: at('2026-01-01', '10:00') });
    expect(plan([], [old]).ops).toEqual([]);
  });

  it('reports another mirror’s copies and never touches them', () => {
    const [copy] = desired(item());
    const theirs = existing(copy!, {
      marker: { contentHash: copy!.contentHash, rev: 5, tag: mirrorTag('someone-else') },
    });
    const result = plan([], [theirs]);
    expect(result).toMatchObject({ foreign: 1, ops: [], present: 0 });
  });

  it('keeps the first of two events under one key and flags the other', () => {
    const [copy] = desired(item());
    const first = existing(copy!, { order: 'a', ref: 'first' });
    const second = existing(copy!, { order: 'b', ref: 'second' });
    const result = plan([copy!], [second, first]);
    expect(result.ops).toEqual([{ actual: second, kept: first, kind: 'duplicate' }]);
  });

  it('stamps one copy with a new revision when nothing else changes', () => {
    const copies = desired(
      item({ key: 'past', startUtc: at('2026-03-09', '10:00') }),
      item({ key: 'next' }),
    );
    const older = copies.map((copy) =>
      existing(copy, { marker: { contentHash: copy.contentHash, rev: 500, tag } }),
    );
    const result = plan(copies, older);
    // The nearest upcoming copy carries the revision; the other is left alone.
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toMatchObject({
      copy: { startUtc: at('2026-03-11', '10:00') },
      kind: 'update',
    });
    expect(result.newestRev).toBe(500);
    // Once it carries it, the next plan is empty.
    const stamped = copies.map((copy, index) =>
      existing(copy, {
        marker: { contentHash: copy.contentHash, rev: index === 1 ? 1000 : 500, tag },
      }),
    );
    expect(plan(copies, stamped).ops).toEqual([]);
  });

  it('reports the newest revision it sees, for a device on an older definition', () => {
    const [copy] = desired(item());
    const newer = existing(copy!, { marker: { contentHash: copy!.contentHash, rev: 9999, tag } });
    expect(plan([copy!], [newer]).newestRev).toBe(9999);
  });
});
