import { Schema } from 'effect';
import { MirrorDefinition } from './definition.ts';

/**
 * How a mirror is doing on this device. On/off and everything below is
 * device-local — the definition travels in the settings document, this
 * never does.
 */

/**
 * Why a mirror is not copying right now. `waiting` reasons clear by
 * themselves (a sync finishes, an account signs in); `paused` ones need
 * the user.
 */
export const MirrorReason = Schema.Literals([
  /** An account a source or the destination belongs to is signed out. */
  'accountSignedOut',
  /** Two calendars or lists here match one name; the mirror cannot tell which is meant. */
  'ambiguous',
  /** Apple Calendar or Reminders is not connected (or its bridge is unavailable). */
  'appleUnavailable',
  'destinationMissing',
  'destinationReadOnly',
  /** The destination is in an account that does not keep the event URL (Exchange). */
  'destinationUnsupported',
  /** The last run failed; the next one tries again. */
  'error',
  /** The run would remove a large share of the copies; it waits before doing so. */
  'largeRemoval',
  /** A copy in the destination was written by a newer version of this mirror. */
  'newerDefinition',
  /** Another mirror's copies are in the destination. */
  'otherMirror',
  /** The same copy was rewritten again and again — something keeps undoing it. */
  'rewriteLoop',
  'sourceMissing',
  /** A source or the destination has not finished syncing. */
  'syncing',
  /** A source holds changes that have not reached Google yet. */
  'unsyncedChanges',
]);
export type MirrorReason = typeof MirrorReason.Type;

export const MirrorState = Schema.Literals(['copying', 'off', 'paused', 'upToDate', 'waiting']);
export type MirrorState = typeof MirrorState.Type;

export const MirrorStatus = Schema.Struct({
  /** Copies in the destination's window after the last run. */
  copies: Schema.Number,
  /** The calendar, list or account `reason` is about, when there is one. */
  detail: Schema.optional(Schema.String),
  /** Epoch ms of the last run that got as far as comparing. */
  lastRunAt: Schema.optional(Schema.Number),
  /** Writes still to make (a capped run continues with the next one). */
  pending: Schema.Number,
  reason: Schema.optional(MirrorReason),
  state: MirrorState,
});
export type MirrorStatus = typeof MirrorStatus.Type;

export const MIRROR_STATUS_OFF: MirrorStatus = { copies: 0, pending: 0, state: 'off' };

/** A mirror as the settings UI lists it. */
export const MirrorView = Schema.Struct({
  definition: MirrorDefinition,
  /** Whether this device runs it. */
  enabled: Schema.Boolean,
  status: MirrorStatus,
});
export type MirrorView = typeof MirrorView.Type;

/** What a copy looks like to the people the destination is shared with. */
export const MirrorSample = Schema.Struct({
  allDay: Schema.Boolean,
  description: Schema.optional(Schema.String),
  endDate: Schema.optional(Schema.String),
  endUtc: Schema.Number,
  location: Schema.optional(Schema.String),
  startDate: Schema.optional(Schema.String),
  startUtc: Schema.Number,
  title: Schema.String,
});
export type MirrorSample = typeof MirrorSample.Type;

/** What a definition would do, before it is saved. */
export const MirrorPreview = Schema.Struct({
  /** Why it could not be computed (a source that is missing here, …). */
  blocked: Schema.optional(
    Schema.Struct({ detail: Schema.optional(Schema.String), reason: MirrorReason }),
  ),
  /** How many copies the destination would hold. */
  copies: Schema.Number,
  /** Events already in the destination that are not this mirror's: it is not a dedicated calendar. */
  otherEvents: Schema.Number,
  /** The next few copies, as written. */
  samples: Schema.Array(MirrorSample),
});
export type MirrorPreview = typeof MirrorPreview.Type;

const REASON_TEXT: Record<MirrorReason, (detail: string | undefined) => string> = {
  accountSignedOut: (detail) =>
    `${detail ?? 'An account'} is signed out. Sign in again to continue.`,
  ambiguous: (detail) =>
    `More than one calendar or list here is called ${detail ?? 'the same'}. Rename one so the mirror can tell them apart.`,
  appleUnavailable: (detail) => `${detail ?? 'Apple Calendar'} is not connected on this device.`,
  destinationMissing: (detail) =>
    `The destination ${detail ?? 'calendar'} was not found on this device.`,
  destinationReadOnly: (detail) => `The destination ${detail ?? 'calendar'} is read-only.`,
  destinationUnsupported: (detail) =>
    `${detail ?? 'The destination'} is in an account that cannot hold mirrored events. Use an iCloud or Google calendar.`,
  error: (detail) => `The last run failed${detail ? `: ${detail}` : ''}. It will try again.`,
  largeRemoval: () =>
    'Many copies would be removed at once. Waiting a few minutes in case a source is still loading — or run it now.',
  newerDefinition: () =>
    'This mirror was changed on another device. Import the settings from that device to continue here.',
  otherMirror: () =>
    'Another mirror already copies into this calendar. Import the settings from the device that runs it.',
  rewriteLoop: () =>
    'Something keeps undoing this mirror’s copies, so it stopped here. Check your other devices, then switch it on again.',
  sourceMissing: (detail) => `The source ${detail ?? 'calendar'} was not found on this device.`,
  syncing: () => 'Waiting for the calendars to finish syncing.',
  unsyncedChanges: () => 'Waiting for unsynced changes to reach Google.',
};

/** The reason in words — the same on both platforms. */
export const describeMirrorReason = (reason: MirrorReason, detail?: string): string =>
  REASON_TEXT[reason](detail);

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** One line for the mirror's row: what it is doing, or why it is not. */
export const describeMirrorStatus = (status: MirrorStatus): string => {
  switch (status.state) {
    case 'copying':
      return `Copying — ${plural(status.pending, 'change')} to go.`;
    case 'off':
      return 'Off on this device.';
    case 'upToDate':
      return `Up to date — ${plural(status.copies, 'event')} mirrored.`;
    case 'paused':
    case 'waiting':
      return status.reason === undefined
        ? 'Waiting.'
        : describeMirrorReason(status.reason, status.detail);
  }
};

/**
 * What the settings UI says about mirrors before anyone makes one. Kept
 * here so both apps explain it in the same words.
 */
export const MIRROR_COPY = {
  appleMarker:
    'Copies in an Apple calendar carry a Solunivo link in their URL field. That is how the mirror finds them again.',
  dedicated:
    'Use a calendar made for this mirror. Solunivo only ever changes its own copies, but a dedicated calendar keeps them apart from everything else — and is the one you share.',
  devices:
    'A mirror made on one device runs on another after you import its settings there, and each device has its own on/off switch. Set up by hand on two devices, the mirrors would not recognise each other.',
  freshness:
    'Copies are only updated while Solunivo is running on one of your devices. If none is, the shared calendar shows the last state.',
  hidden:
    'Copies are hidden inside Solunivo — you already see the originals. Open the calendar in Google Calendar or Calendar to see what others see.',
  intro:
    'A mirror copies events from your calendars and lists into one calendar you can share, leaving out what you choose. It works one way: the copies belong to Solunivo and are overwritten, changes to them are not copied back.',
  sharing:
    'Share the destination calendar read-only in Google Calendar or Calendar; Solunivo does not change who can see it.',
  window: (months: number): string =>
    `Events from the past week and the next ${plural(months, 'month')} are copied. Repeating events are copied one by one for that time, not as a series.`,
} as const;

export const MIRROR_PRESET_COPY = {
  availability: {
    description:
      'Others see when you are busy, nothing else. Overlapping events show as one block.',
    title: 'Availability',
  },
  custom: {
    description: 'Your own choice of fields and filters.',
    title: 'Custom',
  },
  full: {
    description: 'Title, location, description and the meeting link. Guests are never copied.',
    title: 'Full details',
  },
  titleLocation: {
    description: 'Others see what and where, not the description or who else is invited.',
    title: 'Title and location',
  },
} as const;
