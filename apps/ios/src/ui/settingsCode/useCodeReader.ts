import type { SettingsImportSummary } from '@calendar/core';
import { useRef } from 'react';
import { useSettingsCodeReader } from '../../settingsCodeInbox.ts';
import { useSettingsTransfer } from '../settings/useSettingsTransfer.ts';

/**
 * One reader's logic, shared by the setup's copy door and Settings › Read
 * Code: a code from the camera, the paste field or the inbox (a share, the
 * Camera app's "Open in Solunivo") goes through the same alert preview and
 * import as a settings file. A code is read once — the camera reports it
 * many times a second, and a declined preview must not come straight back
 * — until a fresh scan starts (`reset`).
 */
export const useCodeReader = (onImported: (summary: SettingsImportSummary) => void) => {
  const transfer = useSettingsTransfer();
  const tried = useRef<string | null>(null);
  const reading = useRef(false);

  const read = async (code: string) => {
    if (reading.current || tried.current === code) {
      return;
    }
    tried.current = code;
    reading.current = true;
    try {
      const summary = await transfer.importCode(code);
      if (summary) {
        onImported(summary);
      }
    } finally {
      reading.current = false;
    }
  };

  useSettingsCodeReader((code) => void read(code));

  return {
    busy: transfer.busy,
    importSettings: transfer.importSettings,
    notice: transfer.notice,
    read: (code: string) => void read(code),
    reset: () => {
      tried.current = null;
    },
  };
};
