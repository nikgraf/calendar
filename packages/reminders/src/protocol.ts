import { Schema } from 'effect';

/**
 * The Reminders JSON contract shared by three implementations: this TS
 * client, the macOS Swift helper (`reminders.*` stdio methods), and the
 * iOS Expo module. Both native sides are generated from one Swift source
 * (packages/reminders/swift/RemindersBridge.swift); the schemas here
 * decode what comes back so a drift on either side fails loudly at the
 * boundary instead of as undefined fields in the UI.
 *
 * Conventions (mirrored in Swift):
 * - dates are 'YYYY-MM-DD', times 'HH:MM', both in the device zone;
 *   a reminder whose EK dueDateComponents carry no hour is all-day and
 *   has no `dueTime`.
 * - `priority` is EventKit's raw 0…9 (0 none, 1–4 high, 5 medium, 6–9 low).
 * - `alarms` are minutes relative to the due date (≤ 0 = before/at);
 *   absolute-date alarms are neither surfaced nor touched.
 * - `recurrence` is our RecurrenceRuleSpec subset; anything EventKit can
 *   express that we can't (by-day, positional, multiple rules) comes
 *   back as `{ unsupported: true }` and is never overwritten.
 */

export const RemindersAuthorization = Schema.Literals([
  'denied',
  'fullAccess',
  'notDetermined',
  'restricted',
  'unavailable',
  'writeOnly',
]);
export type RemindersAuthorization = typeof RemindersAuthorization.Type;

export const ReminderListJson = Schema.Struct({
  allowsModifications: Schema.Boolean,
  colorHex: Schema.optional(Schema.String),
  id: Schema.String,
  title: Schema.String,
});
export type ReminderListJson = typeof ReminderListJson.Type;

export const ReminderRecurrenceJson = Schema.Union([
  Schema.Struct({
    count: Schema.optional(Schema.Number),
    freq: Schema.Literals(['daily', 'monthly', 'weekly', 'yearly']),
    interval: Schema.Number,
    untilDate: Schema.optional(Schema.String),
  }),
  Schema.Struct({ unsupported: Schema.Literal(true) }),
]);
export type ReminderRecurrenceJson = typeof ReminderRecurrenceJson.Type;

export const ReminderJson = Schema.Struct({
  alarms: Schema.Array(Schema.Number),
  completed: Schema.Boolean,
  completedAt: Schema.optional(Schema.Number),
  dueDate: Schema.optional(Schema.String),
  dueTime: Schema.optional(Schema.String),
  id: Schema.String,
  listId: Schema.String,
  notes: Schema.optional(Schema.String),
  priority: Schema.Number,
  recurrence: Schema.optional(ReminderRecurrenceJson),
  title: Schema.String,
  updatedAt: Schema.Number,
  url: Schema.optional(Schema.String),
});
export type ReminderJson = typeof ReminderJson.Type;

/**
 * Fields a write may carry. `null` clears a field (JSON has no way to say
 * "absent" once encoded, so the Swift side treats null as clear and a
 * missing key as unchanged).
 */
export interface ReminderWrite {
  readonly alarms?: ReadonlyArray<number> | null | undefined;
  readonly dueDate?: string | null | undefined;
  readonly dueTime?: string | null | undefined;
  readonly notes?: string | null | undefined;
  readonly priority?: number | undefined;
  readonly recurrence?:
    | {
        readonly count?: number;
        readonly freq: string;
        readonly interval: number;
        readonly untilDate?: string;
      }
    | null
    | undefined;
  readonly title?: string | undefined;
  readonly url?: string | null | undefined;
}

export const StatusResult = Schema.Struct({ authorization: RemindersAuthorization });
export const RequestAccessResult = Schema.Struct({ granted: Schema.Boolean });
export const ListListsResult = Schema.Struct({ lists: Schema.Array(ReminderListJson) });
export const ListResult = Schema.Struct({ reminders: Schema.Array(ReminderJson) });
export const ReminderResult = Schema.Struct({ reminder: ReminderJson });

/** Method names as the native sides dispatch them. */
export const REMINDERS_METHODS = {
  create: 'reminders.create',
  delete: 'reminders.delete',
  list: 'reminders.list',
  listLists: 'reminders.listLists',
  requestAccess: 'reminders.requestAccess',
  setCompleted: 'reminders.setCompleted',
  status: 'reminders.status',
  update: 'reminders.update',
} as const;
