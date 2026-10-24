import { useState } from 'react';
import { SETTINGS_BUTTON_CLASS } from '../ui/buttonStyles.ts';
import { CodeImportDialog } from './CodeImportDialog.tsx';
import { SettingsCodeCard } from './SettingsCodeCard.tsx';

/**
 * Settings › Settings File's first card: this Mac's settings as a code for
 * the iPhone to read, and the reader for a code the iPhone shows. The file
 * (Export & import, the linked file) stays below for Mac to Mac and backups.
 */
export function SettingsCodeSection() {
  const [reading, setReading] = useState(false);
  return (
    <section className="rounded-popover bg-surface-subtle p-4" data-testid="settings-code-section">
      <h2 className="font-medium">Copy to iPhone</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        Show this code to Solunivo on the iPhone: its welcome screen offers “Copy from your Mac”,
        and Settings › Settings File › Read Code from Your Mac reads it any time. It holds account
        addresses and calendar choices, never passwords or tokens — read it with Solunivo, not the
        Camera app.
      </p>
      <div className="mt-3 flex flex-col">
        <SettingsCodeCard qrSize={232} />
      </div>
      <div className="mt-4 border-t border-hairline pt-3">
        <h3 className="text-sm font-medium">Copy from iPhone</h3>
        <p className="mt-1 text-sm text-ink-secondary">
          On the iPhone, open Settings › Settings File › Show Code for Your Mac, then read it here
          with the camera or paste it.
        </p>
        <button
          className={`${SETTINGS_BUTTON_CLASS} mt-2`}
          data-testid="settings-code-read"
          onClick={() => setReading(true)}
          type="button"
        >
          Copy from iPhone…
        </button>
      </div>
      {reading ? <CodeImportDialog camera onClose={() => setReading(false)} /> : null}
    </section>
  );
}
