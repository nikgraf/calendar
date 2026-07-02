import { appName, Temporal } from '@calendar/core';

export function App() {
  const today = Temporal.Now.plainDateISO();

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 bg-neutral-50 text-neutral-900">
      <h1 className="text-3xl font-semibold">{appName}</h1>
      <p className="text-neutral-500">
        {today.toLocaleString('en-US', {
          day: 'numeric',
          month: 'long',
          weekday: 'long',
          year: 'numeric',
        })}
      </p>
    </div>
  );
}
