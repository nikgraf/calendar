import type { SettingsImportSummary } from '@calendar/core';
import { useRef } from 'react';
import { useSettingsCodeReader } from '../../settingsCodeInbox.ts';
import { useSettingsTransfer } from '../settings/useSettingsTransfer.ts';

/**
 * One reader's logic, shared by the setup's copy door and Settings › Read
 * Code: a code from the camera, the paste field or the inbox (a share, the
 * Camera app's "Open in Solunivo") goes through the same alert preview and
 * import as a settings file. The camera reports a code many times a
 * second, so a camera code is read once — a declined preview must not
 * come straight back — until a fresh scan starts (`reset`). A paste or a
 * code from outside is the person asking, and is read every time.
 *
 * `read` answers whether it ran (a camera repeat, or anything while a read
 * is under way, does not): the scanner goes back to its button after one
 * that ran, so scanning the same code again is a tap away. `onReading`
 * hears each read that starts, before its outcome.
 */
export const useCodeReader = (
  onImported: (summary: SettingsImportSummary) => void,
  onReading?: () => void,
) => {
  const transfer = useSettingsTransfer();
  const tried = useRef<string | null>(null);
  const reading = useRef(false);

  const read = async (code: string, from: 'camera' | 'paste'): Promise<boolean> => {
    if (reading.current || (from === 'camera' && tried.current === code)) {
      return false;
    }
    tried.current = code;
    reading.current = true;
    onReading?.();
    try {
      const summary = await transfer.importCode(code);
      if (summary) {
        onImported(summary);
      }
    } finally {
      reading.current = false;
    }
    return true;
  };

  useSettingsCodeReader((code) => void read(code, 'paste'));

  return {
    busy: transfer.busy,
    importSettings: transfer.importSettings,
    notice: transfer.notice,
    paste: (code: string) => void read(code, 'paste'),
    reset: () => {
      tried.current = null;
    },
    scan: (code: string) => read(code, 'camera'),
  };
};
