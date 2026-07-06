import { useEffect, useState } from 'react';
import type { PrivacyState } from './backend.ts';

type Choice = 'hidden' | 'pause10m' | 'visible';

/** Screen-sharing privacy control backed by the main-process window state. */
export function PrivacySection() {
  const [state, setState] = useState<PrivacyState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let mounted = true;
    void window.calendarBridge.privacyGet().then((current) => {
      if (mounted) {
        setState(current);
      }
    });
    const unsubscribe = window.calendarBridge.onPrivacyChanged(setState);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const paused = state?.visibleUntil !== undefined && state.visibleUntil > now;
  useEffect(() => {
    if (!paused) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [paused]);

  if (!state) {
    return null;
  }

  const active: Choice = paused ? 'pause10m' : state.mode;
  const minutesLeft = paused ? Math.max(1, Math.ceil((state.visibleUntil! - now) / 60_000)) : 0;
  const options: ReadonlyArray<{ label: string; value: Choice }> = [
    { label: 'Hidden', value: 'hidden' },
    {
      label: paused ? `Visible · ${minutesLeft} min left` : 'Visible for 10 min',
      value: 'pause10m',
    },
    { label: 'Always visible', value: 'visible' },
  ];

  const choose = (choice: Choice) => {
    void window.calendarBridge.privacySet(choice).then(setState);
  };

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      <h2 className="font-medium">Privacy</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Hide this window from screen sharing and recordings. It stays visible on your own display.
      </p>
      <div
        aria-label="Screen-sharing visibility"
        className="mt-3 flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5"
        role="radiogroup"
      >
        {options.map((option) => (
          <button
            aria-checked={active === option.value}
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${
              active === option.value
                ? 'bg-blue-600 text-white'
                : 'text-neutral-600 hover:bg-neutral-200/60'
            }`}
            key={option.value}
            onClick={() => choose(option.value)}
            role="radio"
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
