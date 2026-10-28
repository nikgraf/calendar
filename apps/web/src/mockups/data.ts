/**
 * Sample data the drawn screens share. Names are made up; the week is the
 * one around the brand icon's "24" theme, October 2026.
 */
export type Tint = 'blue' | 'blush' | 'lilac' | 'mint';

export const tintClass: Record<Tint, string> = {
  blue: 'bg-event-blue text-on-event-blue',
  blush: 'bg-event-blush text-on-event-blush',
  lilac: 'bg-event-lilac text-on-event-lilac',
  mint: 'bg-event-mint text-on-event-mint',
};

export const dotClass: Record<Tint, string> = {
  blue: 'bg-event-blue-edge',
  blush: 'bg-event-blush-edge',
  lilac: 'bg-event-lilac-edge',
  mint: 'bg-event-mint-edge',
};

export type TimedEvent = {
  day: number;
  /** Decimal hours, e.g. 11.5 for 11:30. */
  end: number;
  start: number;
  tint: Tint;
  title: string;
};

export type AllDayItem =
  | { kind: 'birthday'; title: string }
  | { done?: boolean; kind: 'task'; title: string };

// Short labels: the hero's week columns are about 70 px wide.
const allDay: ReadonlyArray<ReadonlyArray<AllDayItem>> = [
  [{ kind: 'task', title: 'Passport' }],
  [
    { done: true, kind: 'task', title: 'Call bank' },
    { kind: 'birthday', title: 'Birthday' },
  ],
  [],
  [{ kind: 'task', title: 'Pack' }],
  [],
];

// Titles fit two 11 px lines in a 70 px column (one line for a half hour).
const events: ReadonlyArray<TimedEvent> = [
  { day: 0, end: 10, start: 9, tint: 'lilac', title: 'Team sync' },
  { day: 0, end: 14, start: 13, tint: 'mint', title: 'Lunch' },
  { day: 1, end: 11.5, start: 10, tint: 'lilac', title: 'Design review' },
  { day: 1, end: 16, start: 15, tint: 'blush', title: 'Dentist' },
  { day: 2, end: 12, start: 9, tint: 'mint', title: 'Deep work' },
  { day: 2, end: 14.5, start: 14, tint: 'lilac', title: '1:1 Jonas' },
  { day: 3, end: 10, start: 9, tint: 'lilac', title: 'Standup' },
  { day: 3, end: 18, start: 16, tint: 'blue', title: 'Flight to Berlin' },
  { day: 4, end: 13, start: 10, tint: 'lilac', title: 'Workshop' },
  { day: 4, end: 17, start: 16.5, tint: 'blush', title: 'Pickup' },
];

export const week = {
  allDay,
  days: [
    { label: 'Mon', number: 26 },
    { label: 'Tue', number: 27, today: true },
    { label: 'Wed', number: 28 },
    { label: 'Thu', number: 29 },
    { label: 'Fri', number: 30 },
  ],
  events,
  /** Tuesday, 14:20. */
  now: { day: 1, hour: 14 + 20 / 60 },
  title: 'October 2026',
};

export const calendars: ReadonlyArray<{ name: string; tint: Tint }> = [
  { name: 'Personal', tint: 'mint' },
  { name: 'Work', tint: 'lilac' },
  { name: 'Family', tint: 'blush' },
  { name: 'Travel', tint: 'blue' },
];

export const lists = ['Errands', 'Reminders'];

/**
 * The rail's one Up next card, as the app picks it: the earliest timed
 * event that has not ended (Tuesday's Dentist, 40 minutes after `now`).
 */
export const upNext = { startsIn: 'In 40 min', time: '15:00 – 16:00', title: 'Dentist' };

export const tasks = [
  { title: 'Passport' },
  { title: 'Pack for Berlin' },
  { title: 'Book the hotel' },
  { done: true, title: 'Call bank' },
];

/** `9.5` → `9:30`. */
export function clock(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}

/** `10` → `10`, `11.5` → `11:30`: the compact form the week's narrow blocks use. */
function short(hour: number): string {
  return Number.isInteger(hour) ? `${hour}` : clock(hour);
}

/** `10–11:30`. */
export function range(start: number, end: number): string {
  return `${short(start)}–${short(end)}`;
}
