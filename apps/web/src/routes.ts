export const routes = ['/', '/privacy'] as const;

export type Route = (typeof routes)[number];

/** `/privacy/` and `/privacy` are the same page; anything unknown is home. */
export function routeFor(path: string): Route {
  const trimmed = path.replace(/\/+$/, '') || '/';
  return (routes as ReadonlyArray<string>).includes(trimmed) ? (trimmed as Route) : '/';
}

export const pageMeta: Record<Route, { description: string; title: string }> = {
  '/': {
    description:
      'Solunivo puts Google Calendar, Google Tasks, Apple Calendar and Apple Reminders on one grid, on your Mac and your iPhone. No server in between.',
    title: 'Solunivo — Google and Apple calendars, tasks and reminders. One app.',
  },
  '/privacy': {
    description:
      'What Solunivo accesses, where your data goes, and what stays on your device. The app has no server of its own.',
    title: 'Privacy Policy — Solunivo',
  },
};
