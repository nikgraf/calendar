import { Button } from './ui/Button.tsx';
import { SegmentedControl } from './ui/SegmentedControl.tsx';
import { useEffect, useState } from 'react';
import type { PrivacyState } from './backend.ts';

/**
 * Settings › Screen Sharing: whether Solunivo's windows show up in screen
 * sharing, recordings and screenshots, backed by the main-process window
 * state. Hidden or Visible is the setting; while Hidden, a button shows
 * the windows for 10 minutes (and hides them again early), since a pause
 * of a setting that is off means nothing.
 */
export function PrivacySection() {
  const [state, setState] = useState<PrivacyState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The countdown reads `now`: a new state restarts it from this moment,
  // not from when the pane opened.
  const take = (next: PrivacyState) => {
    setNow(Date.now());
    setState(next);
  };

  useEffect(() => {
    let mounted = true;
    void window.calendarBridge.privacyGet().then((current) => {
      if (mounted) {
        take(current);
      }
    });
    const unsubscribe = window.calendarBridge.onPrivacyChanged(take);
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

  const minutesLeft = paused ? Math.max(1, Math.ceil((state.visibleUntil! - now) / 60_000)) : 0;
  const choose = (choice: 'hidden' | 'pause10m' | 'visible') => {
    void window.calendarBridge.privacySet(choice).then(take);
  };

  return (
    <section className="rounded-popover bg-surface-subtle p-4">
      <p className="text-sm text-ink-secondary">
        Hide Solunivo&rsquo;s windows from screen sharing and recordings. They stay visible on your
        own display.
      </p>
      <SegmentedControl
        className="mt-3 w-full"
        grow
        label="Screen-sharing visibility"
        onChange={choose}
        options={[
          { label: 'Hidden', value: 'hidden' },
          { label: 'Visible', value: 'visible' },
        ]}
        size="sm"
        value={state.mode}
      />
      {state.mode === 'hidden' ? (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline pt-3 text-sm text-ink-secondary">
          <span data-testid="sharing-pause-status">
            {paused ? `Visible to others · ${minutesLeft} min left` : 'Sharing briefly?'}
          </span>
          {paused ? (
            <Button data-testid="sharing-hide-now" onClick={() => choose('hidden')} size="sm">
              Hide now
            </Button>
          ) : (
            <Button data-testid="sharing-show-briefly" onClick={() => choose('pause10m')} size="sm">
              Show for 10 min
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
