import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Account, assembleWindow, CalendarInfo, EventRecord, Temporal } from '@calendar/core';
import { expect, it } from 'vite-plus/test';
import { runBombadil } from './bombadil/driver.ts';
import { launchApp, readEventWindow, readPendingOps } from './harness.ts';

type Scope = 'instance' | 'following' | 'series';

interface Form {
  readonly date: string;
  readonly endDate: string;
  readonly endTime: string;
  readonly startTime: string;
  readonly title: string;
}

interface Saved {
  readonly clicks: number;
  readonly createdMasterId: string | null;
  readonly form: Form;
  readonly opened: {
    readonly exception: boolean;
    readonly form: Form;
    readonly masterId: string;
    readonly moved: boolean;
    readonly slotUtc: number;
    readonly testId: string;
  };
  readonly scope: Scope;
}

interface Probe {
  readonly cancelled: number;
  readonly failure: string | null;
  readonly prefix: number;
  readonly saved: ReadonlyArray<Saved>;
}

/** What one occurrence should show: its series and slot, and its own fields. */
interface Occurrence {
  readonly date: string;
  readonly endTime: string;
  readonly masterId: string;
  readonly slot: string;
  readonly startTime: string;
  readonly title: string;
}

/**
 * One series as the user's edits left it: the days it draws (a split ends
 * one where the next begins), its own title and times, and the
 * occurrences edited on their own, by slot day.
 */
interface Segment {
  readonly exceptions: Map<string, Omit<Occurrence, 'masterId' | 'slot'>>;
  readonly firstDay: string;
  lastDay: string | null;
  /** Exists on Google, so a rename reaches its exceptions there and here. */
  readonly onGoogle: boolean;
  times: { readonly end: string; readonly start: string };
  title: string;
}

const MASTER = 'bombadilseries';
const DAY_MS = 86_400_000;

const day = (iso: string, offset: number): string =>
  Temporal.PlainDate.from(iso).add({ days: offset }).toString();
const isoDay = (utc: number): string => new Date(utc).toISOString().slice(0, 10);
const clock = (utc: number): string => new Date(utc).toISOString().slice(11, 16);
const at = (iso: string, time: string): number => Date.parse(`${iso}T${time}:00Z`);

/**
 * Replays the saves through the documented semantics
 * (docs/architecture.md → Recurring events), independent of the app's
 * code: "This event" stores one exception for its slot; "All events"
 * renames the series (copied onto its exceptions while the series exists
 * on Google) and takes the form's times when they are sent; "This and
 * following" sends them always, ends the series the day
 * before the cut, drops its exceptions from there and starts a new one at
 * the cut with the form's title and times — at the series' first
 * occurrence it is "All events".
 */
const expectedSeries = (seed: Segment, saved: ReadonlyArray<Saved>): Map<string, Segment> => {
  const series = new Map<string, Segment>([[MASTER, seed]]);
  for (const save of saved) {
    const segment = series.get(save.opened.masterId);
    if (!segment) {
      throw new Error(`A save targeted a series the model does not know: ${save.opened.masterId}`);
    }
    const slot = isoDay(save.opened.slotUtc);
    if (slot < segment.firstDay || (segment.lastDay !== null && slot > segment.lastDay)) {
      // The grid drew this occurrence, so the app's series reaches a day
      // its edits gave to another (a split's cut, say).
      throw new Error(
        `The grid drew ${save.opened.masterId} on ${slot}, outside the days its edits left it (${segment.firstDay} to ${segment.lastDay ?? 'open'})`,
      );
    }
    const scope = save.scope === 'following' && slot === segment.firstDay ? 'series' : save.scope;
    const { form } = save;
    if (scope === 'instance') {
      segment.exceptions.set(slot, {
        date: form.date,
        endTime: form.endTime,
        startTime: form.startTime,
        title: form.title,
      });
    } else if (scope === 'series') {
      // The form's times go whenever they changed, and always with "This
      // and following": the series then starts at them, measured from the
      // slot (an occurrence edited on its own may show other times).
      const timesSent =
        save.scope === 'following' ||
        form.startTime !== save.opened.form.startTime ||
        form.endTime !== save.opened.form.endTime;
      if (timesSent) {
        if (form.startTime !== segment.times.start) {
          expect(segment.exceptions.size, 'the actions retimed a series with exceptions').toBe(0);
        }
        segment.times = { end: form.endTime, start: form.startTime };
      }
      segment.title = form.title;
      if (segment.onGoogle) {
        for (const [key, exception] of segment.exceptions) {
          segment.exceptions.set(key, { ...exception, title: form.title });
        }
      }
    } else {
      expect(form.date, 'the actions moved a split').toBe(slot);
      expect(save.createdMasterId, 'a split names its new series').not.toBeNull();
      series.set(save.createdMasterId!, {
        exceptions: new Map(),
        firstDay: slot,
        lastDay: segment.lastDay,
        onGoogle: false,
        times: { end: form.endTime, start: form.startTime },
        title: form.title,
      });
      segment.lastDay = day(slot, -1);
      for (const key of segment.exceptions.keys()) {
        if (key >= slot) {
          segment.exceptions.delete(key);
        }
      }
    }
  }
  return series;
};

const occurrencesOf = (
  series: ReadonlyMap<string, Segment>,
  firstDay: string,
  lastDay: string,
): Array<Occurrence> =>
  [...series].flatMap(([masterId, segment]) => {
    const out: Array<Occurrence> = [];
    const end = segment.lastDay !== null && segment.lastDay < lastDay ? segment.lastDay : lastDay;
    for (
      let slot = segment.firstDay < firstDay ? firstDay : segment.firstDay;
      slot <= end;
      slot = day(slot, 1)
    ) {
      const own = segment.exceptions.get(slot);
      out.push({
        masterId,
        slot,
        ...(own ?? {
          date: slot,
          endTime: segment.times.end,
          startTime: segment.times.start,
          title: segment.title,
        }),
      });
    }
    return out;
  });

const byKey = (a: Occurrence, b: Occurrence) =>
  a.masterId.localeCompare(b.masterId) || a.slot.localeCompare(b.slot);

it.runIf(process.env['BOMBADIL'] === '1')(
  'Bombadil: a recurring edit changes only its scope, a split happens once, and cancelling keeps the series',
  { retry: 0, timeout: 180_000 },
  async ({ signal }) => {
    const today = Temporal.Now.plainDateISO('UTC').toString();
    // Two weeks of the series before today's week, so a split or a rename
    // has occurrences outside the visible week to leave alone or reach.
    const firstDay = day(today, -14);
    const seedSeries = new EventRecord({
      accountId: 'acc-bombadil-recurring',
      calendarId: 'cal-bombadil-recurring',
      endUtc: at(firstDay, '09:30'),
      etag: '"seed"',
      id: MASTER,
      isAllDay: false,
      // Daily, so the visible week holds seven occurrences to scope edits between.
      recurrence: ['RRULE:FREQ=DAILY'],
      startTimeZone: 'UTC',
      startUtc: at(firstDay, '09:00'),
      status: 'confirmed',
      syncedAt: 1,
      syncStatus: 'synced',
      title: 'Bombadil daily series',
      updatedAt: 1,
    });
    const app = await launchApp(
      {
        accounts: [
          new Account({
            contactsEnabled: false,
            createdAt: 1,
            email: 'bombadil@example.com',
            id: 'acc-bombadil-recurring',
            provider: 'google',
            status: 'ok',
            tasksEnabled: false,
          }),
        ],
        calendars: [
          new CalendarInfo({
            accessRole: 'owner',
            accountId: 'acc-bombadil-recurring',
            colorHex: '#3b82f6',
            id: 'cal-bombadil-recurring',
            isPrimary: true,
            isVisible: true,
            provider: 'google',
            summary: 'Bombadil calendar',
            timeZone: 'UTC',
          }),
        ],
        events: [seedSeries],
      },
      // The grid, the form and the stored rows all read UTC wall clock.
      { env: { TZ: 'UTC' }, model: 'fixture' },
    );
    const output = join(
      import.meta.dirname,
      '..',
      'e2e-artifacts',
      `bombadil-recurring-${Date.now()}`,
    );
    mkdirSync(output, { recursive: true });
    try {
      await app.cdp.showRail();
      await app.cdp.waitUntil(
        ($, id: string) => $.has(`[data-testid^="timed-event-${id}__"]`),
        MASTER,
      );
      await app.cdp.evaluate(
        (_, seed: { firstDay: string; masterId: string }) => {
          document.body.dataset['bombadilRecurringSeed'] = JSON.stringify(seed);
        },
        { firstDay, masterId: MASTER },
      );
      const origin = await app.cdp.evaluate(() => window.location.href);
      const reproduce = process.env['BOMBADIL_RECURRING_REPRODUCE'];
      await runBombadil(
        [
          '--remote-debugger',
          app.remoteDebugger,
          '--output-path',
          output,
          ...(reproduce
            ? ['--reproduce', resolve(reproduce)]
            : ['--time-limit', '45s', '--exit-on-violation']),
          origin,
          join(import.meta.dirname, 'bombadil', 'recurringEditor.ts'),
        ],
        output,
        signal,
      );
      await app.cdp.waitUntil(() => document.body.dataset['bombadilRecurringBusy'] !== 'true');
      const probe = JSON.parse(
        await app.cdp.evaluate(() => document.body.dataset['bombadilRecurringProbe'] ?? '{}'),
      ) as Probe;
      writeFileSync(join(output, 'recurring-editor-probe.json'), JSON.stringify(probe, null, 2));
      expect(probe.failure).toBeNull();
      // The opening ran through: a cancellation and each scope saved.
      expect(probe.prefix).toBeGreaterThanOrEqual(5);
      expect(probe.cancelled).toBeGreaterThan(0);
      for (const scope of ['instance', 'following', 'series'] as const) {
        expect(probe.saved.some((save) => save.scope === scope)).toBe(true);
      }

      // Everything the series draws, from its first day to well past the
      // farthest a moved occurrence can go: the visible week is a sliver.
      const lastDay = day(today, 50);
      const stored = await readEventWindow(
        app.userDataDir,
        at(day(firstDay, -2), '00:00'),
        at(day(lastDay, 1), '00:00'),
      );
      const series = expectedSeries(
        {
          exceptions: new Map(),
          firstDay,
          lastDay: null,
          onGoogle: true,
          times: { end: '09:30', start: '09:00' },
          title: seedSeries.title,
        },
        probe.saved,
      );
      const drawn = assembleWindow(
        stored,
        at(day(firstDay, -2), '00:00'),
        at(day(lastDay, 1), '00:00'),
      );
      const actual = drawn.map((event) => ({
        date: isoDay(event.startUtc),
        endTime: clock(event.endUtc),
        masterId: event.recurringEventId ?? `single:${event.id}`,
        slot: event.originalStartUtc === undefined ? '' : isoDay(event.originalStartUtc),
        startTime: clock(event.startUtc),
        title: event.title,
      }));
      writeFileSync(
        join(output, 'recurring-editor-expected.json'),
        JSON.stringify(
          [...series].map(([id, segment]) => ({
            ...segment,
            exceptions: Object.fromEntries(segment.exceptions),
            id,
          })),
          null,
          2,
        ),
      );
      writeFileSync(join(output, 'recurring-editor-drawn.json'), JSON.stringify(actual, null, 2));
      expect(actual.sort(byKey)).toEqual(occurrencesOf(series, firstDay, lastDay).sort(byKey));

      // A split makes exactly one series, whatever the burst: the stored
      // masters are the seed plus one per split the ledger names, and the
      // queue holds one create for each — none for anything else.
      const created = probe.saved.flatMap((save) =>
        save.createdMasterId === null ? [] : [save.createdMasterId],
      );
      expect(new Set(created).size).toBe(created.length);
      expect(stored.masters.map((master) => master.id).sort()).toEqual([MASTER, ...created].sort());
      const ops = await readPendingOps(app.userDataDir);
      expect(
        ops
          .filter((op) => op.kind === 'create')
          .map((op) => op.eventId)
          .sort(),
      ).toEqual([...created].sort());
      // One stored exception per slot edited on its own, and none left
      // standing for a slot a later split took.
      for (const [masterId, segment] of series) {
        const exceptions = stored.overrides
          .filter((row) => row.recurringEventId === masterId && row.status !== 'cancelled')
          .map((row) => isoDay(row.originalStartUtc!));
        expect(exceptions.sort(), `exceptions of ${masterId}`).toEqual(
          [...segment.exceptions.keys()].sort(),
        );
      }
      expect(drawn.every((event) => event.endUtc - event.startUtc < DAY_MS)).toBe(true);
    } catch (error) {
      await app.dump('bombadil-recurring');
      throw error;
    } finally {
      await app.stop();
    }
  },
);
