import { AppleCalendarClient } from '@calendar/apple-calendar';
import {
  type Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  APPLE_REMINDERS_ACCOUNT_ID,
  type CalendarInfo,
  eventsScope,
  isCalendarWritable,
  type MirrorCalendarRef,
  type MirrorDefinition,
  type MirrorReason,
  mirrorRefKey,
  type MirrorSourceRef,
  type TaskListInfo,
  tasksScope,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, PendingOpRepo, SyncStateRepo, TaskRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { appleCalendarSource } from './importedVisibility.ts';

/**
 * A mirror's definition names calendars and lists the portable way (it
 * travels between devices); this turns those names into this device's
 * rows, or says why it cannot. A mirror runs only when every source and
 * the destination resolve to exactly one row here: a device that sees
 * half the sources would otherwise delete the other half's copies.
 */

/** Why a mirror does not run here; `detail` names the calendar, list or account. */
export interface MirrorBlock {
  readonly detail?: string | undefined;
  readonly reason: MirrorReason;
}

export type ResolvedCalendar =
  | {
      readonly account: Account;
      readonly calendar: CalendarInfo;
      readonly provider: 'google';
      readonly refKey: string;
    }
  | { readonly calendar: CalendarInfo; readonly provider: 'apple'; readonly refKey: string };

export type ResolvedSource =
  | ResolvedCalendar
  | { readonly account: Account; readonly list: TaskListInfo; readonly provider: 'googleTasks' }
  | { readonly list: TaskListInfo; readonly provider: 'reminders' };

export interface ResolvedMirror {
  readonly destination: ResolvedCalendar;
  readonly sources: ReadonlyArray<ResolvedSource>;
}

/** How old a Google pull may be for a mirror to trust what this device holds. */
export const MIRROR_FRESHNESS_MS = 5 * 60_000;

type Resolved<A> = { readonly block: MirrorBlock } | { readonly value: A };

const block = (reason: MirrorReason, detail?: string): { readonly block: MirrorBlock } => ({
  block: { detail, reason },
});

type ResolveServices = AccountRepo | CalendarRepo | TaskRepo;

const googleAccount = (
  email: string,
  missing: MirrorReason,
): Effect.Effect<Resolved<Account>, SqlError, AccountRepo> =>
  Effect.gen(function* () {
    const wanted = email.toLowerCase();
    const account = (yield* (yield* AccountRepo).list()).find(
      (candidate) => candidate.provider === 'google' && candidate.email.toLowerCase() === wanted,
    );
    if (account === undefined) {
      return block(missing, email);
    }
    return account.status === 'ok' ? { value: account } : block('accountSignedOut', account.email);
  });

const calendarLabel = (ref: MirrorCalendarRef): string =>
  ref.kind === 'google' ? (ref.title ?? ref.calendarId) : ref.title;

const resolveCalendar = (
  ref: MirrorCalendarRef,
  missing: 'destinationMissing' | 'sourceMissing',
): Effect.Effect<Resolved<ResolvedCalendar>, SqlError, ResolveServices> =>
  Effect.gen(function* () {
    const calendars = yield* CalendarRepo;
    const refKey = mirrorRefKey(ref);
    if (ref.kind === 'google') {
      const account = yield* googleAccount(ref.email, missing);
      if ('block' in account) {
        return account;
      }
      const calendar = (yield* calendars.list(account.value.id)).find(
        (candidate) => candidate.id === ref.calendarId,
      );
      return calendar === undefined
        ? block(missing, calendarLabel(ref))
        : { value: { account: account.value, calendar, provider: 'google' as const, refKey } };
    }
    const account = yield* (yield* AccountRepo).get(APPLE_CALENDAR_ACCOUNT_ID);
    if (account === undefined || account.status !== 'ok') {
      return block('appleUnavailable', 'Apple Calendar');
    }
    const matches = (yield* calendars.list(APPLE_CALENDAR_ACCOUNT_ID)).filter(
      (candidate) =>
        appleCalendarSource(candidate) === ref.source && candidate.summary === ref.title,
    );
    if (matches.length > 1) {
      return block('ambiguous', ref.title);
    }
    const [calendar] = matches;
    return calendar === undefined
      ? block(missing, ref.title)
      : { value: { calendar, provider: 'apple' as const, refKey } };
  });

const resolveSource = (
  ref: MirrorSourceRef,
): Effect.Effect<Resolved<ResolvedSource>, SqlError, ResolveServices> =>
  Effect.gen(function* () {
    if (ref.kind === 'google' || ref.kind === 'apple') {
      return yield* resolveCalendar(ref, 'sourceMissing');
    }
    const tasks = yield* TaskRepo;
    if (ref.kind === 'googleTasks') {
      const account = yield* googleAccount(ref.email, 'sourceMissing');
      if ('block' in account) {
        return account;
      }
      const list = (yield* tasks.listLists(account.value.id)).find(
        (candidate) => candidate.id === ref.listId,
      );
      return list === undefined
        ? block('sourceMissing', ref.title ?? ref.listId)
        : { value: { account: account.value, list, provider: 'googleTasks' as const } };
    }
    const account = yield* (yield* AccountRepo).get(APPLE_REMINDERS_ACCOUNT_ID);
    if (account === undefined || account.status !== 'ok') {
      return block('appleUnavailable', 'Reminders');
    }
    const matches = (yield* tasks.listLists(APPLE_REMINDERS_ACCOUNT_ID)).filter(
      (candidate) => candidate.title === ref.title,
    );
    if (matches.length > 1) {
      return block('ambiguous', ref.title);
    }
    const [list] = matches;
    return list === undefined
      ? block('sourceMissing', ref.title)
      : { value: { list, provider: 'reminders' as const } };
  });

/**
 * The destination alone — what removing a mirror's copies needs. It must
 * be writable, and an Apple one must sit in an account that keeps the
 * event URL (the copies' marker): iCloud, another CalDAV account or this
 * device, never Exchange.
 */
export const resolveMirrorDestination = (
  definition: Pick<MirrorDefinition, 'destination'>,
): Effect.Effect<Resolved<ResolvedCalendar>, SqlError, AppleCalendarClient | ResolveServices> =>
  Effect.gen(function* () {
    const destination = yield* resolveCalendar(definition.destination, 'destinationMissing');
    if ('block' in destination) {
      return destination;
    }
    const { calendar } = destination.value;
    if (!isCalendarWritable(calendar)) {
      return block('destinationReadOnly', calendar.summary);
    }
    if (destination.value.provider === 'apple') {
      // The stored row does not keep EventKit's source type; ask the store.
      const listed = yield* (yield* AppleCalendarClient)
        .listCalendars()
        .pipe(Effect.orElseSucceed(() => undefined));
      if (listed === undefined) {
        return block('appleUnavailable', 'Apple Calendar');
      }
      const sourceType = listed.find((entry) => entry.id === calendar.id)?.sourceType;
      if (sourceType !== 'calDAV' && sourceType !== 'local') {
        return block('destinationUnsupported', calendar.summary);
      }
    }
    return destination;
  });

/** Every source and the destination as this device's rows, or the first reason it cannot. */
export const resolveMirror = (
  definition: MirrorDefinition,
): Effect.Effect<Resolved<ResolvedMirror>, SqlError, AppleCalendarClient | ResolveServices> =>
  Effect.gen(function* () {
    const sources: Array<ResolvedSource> = [];
    for (const ref of definition.sources) {
      const source = yield* resolveSource(ref);
      if ('block' in source) {
        return source;
      }
      sources.push(source.value);
    }
    const destination = yield* resolveMirrorDestination(definition);
    if ('block' in destination) {
      return destination;
    }
    return { value: { destination: destination.value, sources } };
  });

/**
 * Whether this device's copy of the mirror's Google data can be trusted
 * right now. Every Google calendar and list involved must have been
 * pulled successfully a moment ago — a device that was offline, or is
 * still listing a calendar's history, sees stale or partial sources and
 * would undo a fresher device's copies — and no source may hold an edit
 * that has not reached Google: this device would mirror its own version
 * while another mirrors the server's.
 */
export const mirrorGate = (
  resolved: ResolvedMirror,
  nowMs: number,
): Effect.Effect<MirrorBlock | undefined, SqlError, PendingOpRepo | SyncStateRepo> =>
  Effect.gen(function* () {
    const syncState = yield* SyncStateRepo;
    const pendingOps = yield* PendingOpRepo;
    const fresh = (accountId: string, scope: string, needsToken: boolean) =>
      Effect.map(
        syncState.get(accountId, scope),
        (state) =>
          state !== null &&
          state.status === 'idle' &&
          (!needsToken || state.syncToken !== null) &&
          state.lastSyncAt !== null &&
          nowMs - state.lastSyncAt <= MIRROR_FRESHNESS_MS,
      );
    const sourcesByAccount = new Map<
      string,
      { calendarIds: Array<string>; taskListIds: Array<string> }
    >();
    const sourcesOf = (accountId: string) => {
      let entry = sourcesByAccount.get(accountId);
      if (entry === undefined) {
        entry = { calendarIds: [], taskListIds: [] };
        sourcesByAccount.set(accountId, entry);
      }
      return entry;
    };
    for (const source of [...resolved.sources, resolved.destination]) {
      if (source.provider === 'google') {
        if (!(yield* fresh(source.account.id, eventsScope(source.calendar.id), true))) {
          return { reason: 'syncing' as const };
        }
        if (source !== resolved.destination) {
          sourcesOf(source.account.id).calendarIds.push(source.calendar.id);
        }
      } else if (source.provider === 'googleTasks') {
        if (!(yield* fresh(source.account.id, tasksScope(source.list.id), false))) {
          return { reason: 'syncing' as const };
        }
        sourcesOf(source.account.id).taskListIds.push(source.list.id);
      }
    }
    for (const [accountId, sources] of sourcesByAccount) {
      if ((yield* pendingOps.countFor(accountId, sources)) > 0) {
        return { reason: 'unsyncedChanges' as const };
      }
    }
    return undefined;
  });
