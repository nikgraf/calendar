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
      'Describe an event the way you’d say it and it’s on your calendar. Google and Apple calendars, tasks and reminders in one app, on Mac and iPhone, with AI that runs on your device.',
    title: 'Solunivo — a modern calendar with AI built in',
  },
  '/privacy': {
    description:
      'What Solunivo accesses, where your data goes, and what stays on your device. The app has no server of its own.',
    title: 'Privacy Policy — Solunivo',
  },
};
