import { useEffect, useState } from 'react';
import { Button } from './ui/Button.tsx';
import { EyeOffIcon } from './ui/icons.tsx';

/** How long the hint stays once the capture is over: ⌘⇧3 ends before it shows. */
const LINGER_MS = 5000;

type Phase = 'after' | 'capturing' | 'off';

/**
 * Screen privacy, said when it matters: while a screenshot or recording
 * leaves this window out (captureHint.ts), a light scrim and a card say
 * so. Only the display shows them — the window itself is out of the
 * capture. The card stays a few seconds after the capture ends and offers
 * the 10-minute pause, so the next shot includes the calendar. The scrim
 * lets clicks through: a long recording never blocks the app.
 */
export function CaptureHint() {
  const [phase, setPhase] = useState<Phase>('off');

  useEffect(
    () =>
      window.calendarBridge.onPrivacyCapture((capturing) =>
        setPhase((current) => (capturing ? 'capturing' : current === 'off' ? 'off' : 'after')),
      ),
    [],
  );

  useEffect(() => {
    if (phase !== 'after') {
      return;
    }
    const timer = setTimeout(() => setPhase('off'), LINGER_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const shown = phase !== 'off';
  return (
    <div
      aria-hidden={!shown}
      className={`pointer-events-none fixed inset-0 z-[1000] flex items-center justify-center bg-black/20 transition-opacity duration-200 ${
        shown ? 'opacity-100' : 'invisible opacity-0'
      }`}
      data-phase={phase}
      data-testid="capture-hint"
    >
      <div
        className={`flex w-80 flex-col items-center gap-2 rounded-2xl bg-surface p-5 text-center shadow-xl ${
          shown ? 'pointer-events-auto' : ''
        }`}
        role="status"
      >
        <EyeOffIcon className="text-ink-secondary" size={22} />
        <p className="font-medium">Solunivo is hidden from screenshots</p>
        <p className="text-sm text-ink-secondary">
          Screen privacy keeps it out of screenshots and recordings. It stays visible on your own
          display.
        </p>
        <div className="mt-2 flex gap-2">
          <Button onClick={() => setPhase('off')} size="sm" variant="ghost">
            Keep hidden
          </Button>
          <Button
            data-testid="capture-hint-show"
            onClick={() => {
              setPhase('off');
              void window.calendarBridge.privacySet('pause10m');
            }}
            size="sm"
            variant="primary"
          >
            Show for 10 min
          </Button>
        </div>
      </div>
    </div>
  );
}
