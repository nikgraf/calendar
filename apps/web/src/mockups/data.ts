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

const allDay: ReadonlyArray<ReadonlyArray<AllDayItem>> = [
  [{ kind: 'task', title: 'Renew passport' }],
  [{ done: true, kind: 'task', title: 'Call the bank' }],
  [{ kind: 'birthday', title: 'Mia · birthday' }],
  [{ kind: 'task', title: 'Pack' }],
  [],
];

const events: ReadonlyArray<TimedEvent> = [
  { day: 0, end: 10, start: 9, tint: 'lilac', title: 'Team sync' },
  { day: 0, end: 14, start: 13, tint: 'mint', title: 'Lunch with Sarah' },
  { day: 1, end: 11.5, start: 10, tint: 'lilac', title: 'Design review' },
  { day: 1, end: 16, start: 15, tint: 'blush', title: 'Dentist' },
  { day: 2, end: 12, start: 9, tint: 'mint', title: 'Deep work' },
  { day: 2, end: 14.5, start: 14, tint: 'lilac', title: '1:1 with Jonas' },
  { day: 3, end: 10, start: 9, tint: 'lilac', title: 'Standup' },
  { day: 3, end: 18, start: 16, tint: 'blue', title: 'Flight to Berlin' },
  { day: 4, end: 13, start: 10, tint: 'lilac', title: 'Workshop' },
  { day: 4, end: 17, start: 16.5, tint: 'blush', title: 'Pick up the kids' },
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

export const upNext = [
  { detail: '15:00 · in 40 min', title: 'Dentist' },
  { detail: 'Thu 16:00 · Travel', title: 'Flight to Berlin' },
];

export const tasks = [
  { title: 'Renew passport' },
  { title: 'Pack for Berlin' },
  { title: 'Book the hotel' },
  { done: true, title: 'Call the bank' },
];

/** `9.5` → `9:30`. */
export function clock(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}
