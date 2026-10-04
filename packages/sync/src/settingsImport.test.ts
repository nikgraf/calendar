import type { MirrorDefinition, SettingsDocument } from '@calendar/core';
import { AccountRepo, CalendarRepo, DeviceSettingsRepo, TaskRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';
import {
  readBirthdayReminderOverrides,
  readEventNotificationSettings,
  readTimeZoneSettings,
  writeBirthdayReminderOverrides,
} from './deviceSettings.ts';
import {
  applyPendingVisibility,
  clearPendingVisibility,
  IMPORTED_VISIBILITY_KEY,
  readPendingVisibility,
} from './importedVisibility.ts';
import { buildSettingsDocument } from './settingsExport.ts';
import { readMirrorLocals, readMirrors } from './mirrorSettings.ts';
import { importSettings, previewSettingsImport } from './settingsImport.ts';
import {
  appleCalendarAccount,
  appleRemindersAccount,
  calendar,
  googleAccount,
  makeSettingsTestLayer,
  seed,
  taskList,
} from './testing/settingsTesting.ts';

const visibility = (accountId: string) =>
  Effect.map(
    Effect.flatMap(CalendarRepo, (repo) => repo.list(accountId)),
    (calendars) =>
      Object.fromEntries(calendars.map((calendar) => [calendar.id, calendar.isVisible])),
  );

const listVisibility = (accountId: string) =>
  Effect.map(
    Effect.flatMap(TaskRepo, (repo) => repo.listLists(accountId)),
    (lists) => Object.fromEntries(lists.map((list) => [list.id, list.isVisible])),
  );

const mirror = (id: string, updatedAt: number, destination: string): MirrorDefinition => ({
  busyLabel: 'Busy',
  destination: { calendarId: destination, email: 'me@example.com', kind: 'google' },
  fields: { description: false, location: true, title: true },
  filters: { allDay: 'copy', declined: 'skip', free: 'copy', private: 'busy' },
  id,
  monthsAhead: 3,
  name: id,
  sources: [{ calendarId: 'work', email: 'me@example.com', kind: 'google' }],
  timeZone: 'UTC',
  updatedAt,
});

describe('importSettings', () => {
  it.effect('applies only the sections present, and only when they differ', () => {
    const { applied, layer } = makeSettingsTestLayer({ screenPrivacy: 'hidden' });
    return Effect.gen(function* () {
      const document: SettingsDocument = {
        desktop: { screenPrivacy: 'visible' },
        eventNotifications: { enabled: true, includeAppleCalendar: false },
        timeZones: { primary: 'UTC', zones: ['UTC', 'Europe/Vienna'] },
        version: 1,
      };
      const preview = yield* previewSettingsImport(document);
      expect(preview.settingsChanged).toEqual(['timeZones', 'screenPrivacy']);
      const summary = yield* importSettings(document);
      expect(summary).toEqual(preview);
      expect(yield* readTimeZoneSettings).toEqual({
        primary: 'UTC',
        zones: ['UTC', 'Europe/Vienna'],
      });
      expect(yield* readEventNotificationSettings).toEqual({
        enabled: true,
        includeAppleCalendar: false,
      });
      expect(applied).toEqual([{ screenPrivacy: 'visible' }]);
      // A second import of the same file is quiet.
      expect((yield* importSettings(document)).settingsChanged).toEqual([]);
      expect(applied).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    'imports mirrors switched off, updates newer ones, never removes, and exports them',
    () => {
      const { layer } = makeSettingsTestLayer({});
      return Effect.gen(function* () {
        const document: SettingsDocument = { mirrors: [mirror('a', 10, 'shared')], version: 1 };
        const preview = yield* previewSettingsImport(document);
        expect(preview.settingsChanged).toEqual(['mirrors']);
        yield* importSettings(document);
        expect((yield* readMirrors).map((entry) => entry.id)).toEqual(['a']);
        // Off here until its user turns it on; a repeat import is quiet.
        expect((yield* readMirrorLocals)['a']).toEqual({ enabled: false });
        expect((yield* importSettings(document)).settingsChanged).toEqual([]);

        // A newer revision replaces; an older one is ignored; a collision is named.
        const next: SettingsDocument = {
          mirrors: [mirror('a', 20, 'shared'), mirror('b', 5, 'shared')],
          version: 1,
        };
        const summary = yield* importSettings(next);
        expect(summary.settingsChanged).toEqual(['mirrors']);
        expect(summary.notes.some((note) => note.includes('same calendar'))).toBe(true);
        expect((yield* readMirrors).map((entry) => [entry.id, entry.updatedAt])).toEqual([
          ['a', 20],
        ]);
        expect(
          (yield* importSettings({ mirrors: [mirror('a', 15, 'other')], version: 1 }))
            .settingsChanged,
        ).toEqual([]);
        // A file without the section leaves them alone; the export carries them.
        yield* importSettings({ version: 1 });
        expect((yield* buildSettingsDocument).mirrors?.map((entry) => entry.id)).toEqual(['a']);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect('joins per-person birthday lead days by person and never removes one', () => {
    const { layer } = makeSettingsTestLayer();
    return Effect.gen(function* () {
      yield* writeBirthdayReminderOverrides([
        { day: 4, displayName: 'Alice', leadDays: [1], month: 3 },
        { day: 10, displayName: 'Bob', leadDays: [7], month: 3 },
      ]);
      const document: SettingsDocument = {
        birthdayReminderOverrides: [
          // The same person as "Alice", spelled as the other device has her.
          { day: 4, displayName: 'alice', leadDays: [14], month: 3 },
          { day: 20, displayName: 'Carol', leadDays: [], month: 5 },
        ],
        version: 1,
      };
      expect((yield* previewSettingsImport(document)).settingsChanged).toEqual([
        'birthdayReminderOverrides',
      ]);
      yield* importSettings(document);
      expect(yield* readBirthdayReminderOverrides).toEqual([
        { day: 4, displayName: 'alice', leadDays: [14], month: 3 },
        { day: 10, displayName: 'Bob', leadDays: [7], month: 3 },
        { day: 20, displayName: 'Carol', leadDays: [], month: 5 },
      ]);
      expect((yield* importSettings(document)).settingsChanged).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect('notes a desktop-only section on a host without it', () => {
    const { applied, layer } = makeSettingsTestLayer();
    return Effect.gen(function* () {
      const summary = yield* importSettings({ desktop: { screenPrivacy: 'visible' }, version: 1 });
      expect(summary.settingsChanged).toEqual([]);
      expect(summary.notes).toEqual(['Screen privacy is a desktop setting and was ignored here.']);
      expect(applied).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    'creates an unknown Google account as "sign in again" with its preferences parked',
    () => {
      const { layer } = makeSettingsTestLayer();
      return Effect.gen(function* () {
        const document: SettingsDocument = {
          accounts: [
            {
              calendars: [{ id: 'work', title: 'Work', visible: false }],
              email: 'New@Example.com',
              kind: 'google',
              taskLists: [{ id: 'list-1', title: 'Inbox', visible: false }],
            },
          ],
          version: 1,
        };
        const preview = yield* previewSettingsImport(document);
        expect(preview.googleAccountsToAdd).toEqual(['new@example.com']);
        expect(preview.visibilityPending).toBe(2);
        expect(yield* Effect.flatMap(AccountRepo, (repo) => repo.list())).toEqual([]);

        expect(yield* importSettings(document)).toEqual(preview);
        const accounts = yield* Effect.flatMap(AccountRepo, (repo) => repo.list());
        expect(accounts).toHaveLength(1);
        expect(accounts[0]).toMatchObject({
          email: 'new@example.com',
          provider: 'google',
          status: 'reauth_required',
          tasksEnabled: true,
        });
        expect(yield* readPendingVisibility).toEqual({
          google: {
            'new@example.com': {
              calendars: [{ id: 'work', title: 'Work', visible: false }],
              taskLists: [{ id: 'list-1', title: 'Inbox', visible: false }],
            },
          },
        });

        // The account signs in (same id) and its first sync lands the rows.
        const account = accounts[0]!;
        yield* seed({
          calendars: [calendar(account.id, 'work', 'Work'), calendar(account.id, 'other', 'Other')],
          taskLists: [taskList(account.id, 'list-1', 'Inbox')],
        });
        expect(yield* applyPendingVisibility(account)).toBe(2);
        expect(yield* visibility(account.id)).toEqual({ other: true, work: false });
        expect(yield* listVisibility(account.id)).toEqual({ 'list-1': false });
        expect(yield* readPendingVisibility).toEqual({});
        expect(yield* (yield* DeviceSettingsRepo).get(IMPORTED_VISIBILITY_KEY)).toBeNull();
        // Idempotent: nothing left to apply.
        expect(yield* applyPendingVisibility(account)).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect('flips matching rows now and parks the rest; an existing account is left alone', () => {
    const { layer } = makeSettingsTestLayer();
    return Effect.gen(function* () {
      const account = googleAccount('acc-1', 'nik@example.com');
      yield* seed({
        accounts: [account],
        calendars: [
          calendar('acc-1', 'work', 'Work'),
          calendar('acc-1', 'home', 'Home', { isVisible: false }),
        ],
      });
      const summary = yield* importSettings({
        accounts: [
          {
            calendars: [
              { id: 'work', title: 'Work', visible: false },
              { id: 'home', title: 'Home', visible: false },
              { id: 'shared', title: 'Shared', visible: false },
            ],
            email: 'NIK@example.com',
            kind: 'google',
          },
        ],
        version: 1,
      });
      expect(summary.googleAccountsToAdd).toEqual([]);
      expect(summary.visibilityChanges).toBe(1);
      expect(summary.visibilityPending).toBe(1);
      expect(summary.notes).toEqual([
        '1 entry for nik@example.com not found here yet — applied once they sync.',
      ]);
      expect(yield* visibility('acc-1')).toEqual({ home: false, work: false });
      const accounts = yield* Effect.flatMap(AccountRepo, (repo) => repo.list());
      expect(accounts).toEqual([account]);
      expect(yield* readPendingVisibility).toEqual({
        google: {
          'nik@example.com': {
            calendars: [{ id: 'shared', title: 'Shared', visible: false }],
            taskLists: [],
          },
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect('Apple accounts are never created; their preferences wait for the connect', () => {
    const { layer } = makeSettingsTestLayer();
    return Effect.gen(function* () {
      const document: SettingsDocument = {
        accounts: [
          {
            calendars: [{ source: 'iCloud', title: 'Home', visible: false }],
            kind: 'apple-calendar',
          },
          { kind: 'apple-reminders', taskLists: [{ title: 'Groceries', visible: false }] },
        ],
        version: 1,
      };
      const summary = yield* importSettings(document);
      expect(summary.appleAccountsPending).toEqual([
        { kind: 'apple-calendar', pendingCount: 1 },
        { kind: 'apple-reminders', pendingCount: 1 },
      ]);
      expect(summary.visibilityPending).toBe(2);
      expect(yield* Effect.flatMap(AccountRepo, (repo) => repo.list())).toEqual([]);

      // Connected later: the first sync matches by source + title / title.
      yield* seed({
        accounts: [appleCalendarAccount(), appleRemindersAccount()],
        calendars: [
          calendar('apple-calendar', 'ek-1', 'Home', { sourceTitle: 'iCloud' }),
          calendar('apple-calendar', 'ek-2', 'Home', { sourceTitle: 'Exchange' }),
        ],
        taskLists: [taskList('apple-reminders', 'ek-3', 'Groceries')],
      });
      expect(yield* applyPendingVisibility(appleCalendarAccount())).toBe(1);
      expect(yield* visibility('apple-calendar')).toEqual({ 'ek-1': false, 'ek-2': true });
      expect(yield* applyPendingVisibility(appleRemindersAccount())).toBe(1);
      expect(yield* listVisibility('apple-reminders')).toEqual({ 'ek-3': false });
      expect(yield* readPendingVisibility).toEqual({});
    }).pipe(Effect.provide(layer));
  });

  it.effect('a later import replaces what it parked for an account and keeps the rest', () => {
    const { layer } = makeSettingsTestLayer();
    return Effect.gen(function* () {
      yield* importSettings({
        accounts: [
          {
            calendars: [{ id: 'a', title: 'A', visible: false }],
            email: 'one@example.com',
            kind: 'google',
          },
          {
            calendars: [{ id: 'b', title: 'B', visible: false }],
            email: 'two@example.com',
            kind: 'google',
          },
        ],
        version: 1,
      });
      const summary = yield* importSettings({
        accounts: [
          {
            calendars: [{ id: 'c', title: 'C', visible: true }],
            email: 'one@example.com',
            kind: 'google',
          },
        ],
        version: 1,
      });
      expect(summary.googleAccountsToAdd).toEqual([]);
      expect(yield* readPendingVisibility).toEqual({
        google: {
          'one@example.com': { calendars: [{ id: 'c', title: 'C', visible: true }], taskLists: [] },
          'two@example.com': {
            calendars: [{ id: 'b', title: 'B', visible: false }],
            taskLists: [],
          },
        },
      });
      expect(yield* Effect.flatMap(AccountRepo, (repo) => repo.list())).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });
});

describe('clearPendingVisibility', () => {
  it.effect('removing an account drops what an import parked for it', () => {
    const { layer } = makeSettingsTestLayer();
    return Effect.gen(function* () {
      yield* importSettings({
        accounts: [
          {
            calendars: [{ id: 'a', title: 'A', visible: false }],
            email: 'gone@example.com',
            kind: 'google',
          },
          {
            calendars: [{ id: 'b', title: 'B', visible: false }],
            email: 'kept@example.com',
            kind: 'google',
          },
          {
            calendars: [{ source: 'iCloud', title: 'Home', visible: false }],
            kind: 'apple-calendar',
          },
        ],
        version: 1,
      });
      const accounts = yield* Effect.flatMap(AccountRepo, (repo) => repo.list());
      const gone = accounts.find((account) => account.email === 'gone@example.com')!;
      yield* Effect.flatMap(AccountRepo, (repo) => repo.remove(gone.id));
      yield* clearPendingVisibility(gone);
      yield* clearPendingVisibility(appleCalendarAccount());
      expect(yield* readPendingVisibility).toEqual({
        google: {
          'kept@example.com': {
            calendars: [{ id: 'b', title: 'B', visible: false }],
            taskLists: [],
          },
        },
      });
      const exported = yield* buildSettingsDocument;
      expect(
        exported.accounts?.map((account) => ('email' in account ? account.email : account.kind)),
      ).toEqual(['kept@example.com']);
    }).pipe(Effect.provide(layer));
  });
});
