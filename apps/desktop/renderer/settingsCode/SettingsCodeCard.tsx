import { useSettingsCode } from '@calendar/app-state';
import { useState } from 'react';
import { SETTINGS_BUTTON_CLASS } from '../ui/buttonStyles.ts';
import { Copyable } from '../ui/Copyable.tsx';
import { QrCode } from './QrCode.tsx';

/**
 * This Mac's settings as a code, behind a Show Code button: the code holds
 * account addresses and calendar choices, so it is on screen only once
 * asked for. Then the QR (or, past version 40, a note), what it carries,
 * and its text to copy — the iPhone takes it by camera or by paste.
 * `onTried` hears the reveal and the copy: the lesson's "tried".
 */
export function SettingsCodeCard({
  onTried,
  qrSize,
}: {
  onTried?: (() => void) | undefined;
  qrSize: number;
}) {
  const view = useSettingsCode();
  const [shown, setShown] = useState(false);
  if (!shown) {
    return (
      <button
        className={`${SETTINGS_BUTTON_CLASS} self-start`}
        data-testid="settings-code-show"
        onClick={() => {
          setShown(true);
          onTried?.();
        }}
        type="button"
      >
        Show Code
      </button>
    );
  }
  if (view === null) {
    return <p className="text-sm text-ink-secondary">Reading these settings…</p>;
  }
  return (
    <div className="flex flex-col gap-3" data-testid="settings-code">
      {view.qr ? (
        <QrCode qr={view.qr} size={qrSize} />
      ) : (
        <p className="text-sm text-ink-secondary" data-testid="settings-code-too-large">
          This setup is too large for one code. Copy it as text below, or use Export instead.
        </p>
      )}
      {view.lines.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-secondary">
          {view.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <Copyable
        label="The code as text"
        onCopied={onTried}
        testId="settings-code-text"
        text={view.code}
      />
    </div>
  );
}
