import { useBackendMutations } from '@calendar/app-state';
import { extractSettingsCode } from '@calendar/core/settingsCode';
import { useRef, useState } from 'react';
import { type PendingImport, readSettingsCode } from '../settingsTransfer.ts';
import { FIELD_CLASS } from '../ui/fieldStyles.ts';
import { type QrCameraState, useQrCamera } from './useQrCamera.ts';

const CAMERA_NOTE: Record<Exclude<QrCameraState, 'live'>, string | null> = {
  asking: 'Starting the camera…',
  denied:
    'Camera access is off — allow Solunivo in System Settings › Privacy & Security › Camera, or paste the code.',
  failed: 'The camera stopped reading — paste the code instead.',
  idle: null,
  unavailable: null,
};

/**
 * Reads a settings code by camera or by paste and previews it: `onRead`
 * hears the decoded settings with what importing them would change, and
 * the caller shows its own confirm. The camera runs while `camera` is on
 * and macOS allows it (CALENDAR_CAMERA=off: never, the paste field only).
 * The same text is read once, however many frames show it; a code that
 * fails to decode says why and is not tried again until it changes.
 */
export function ReadCodePanel({
  camera,
  onRead,
}: {
  camera: boolean;
  onRead: (pending: PendingImport) => void;
}) {
  const mutations = useBackendMutations();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const tried = useRef<string | null>(null);

  const read = async (raw: string) => {
    const code = extractSettingsCode(raw);
    if (code === null) {
      setNotice(raw.trim() ? 'That isn’t a Solunivo code.' : null);
      return;
    }
    if (busy || tried.current === code) {
      return;
    }
    tried.current = code;
    setBusy(true);
    setNotice(null);
    try {
      onRead(await readSettingsCode(mutations, code));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const { state, videoRef } = useQrCamera({
    active: camera && !busy,
    onCode: (code) => void read(code),
  });

  const showVideo = camera && (state === 'live' || state === 'asking');
  const note = state === 'live' ? null : CAMERA_NOTE[state];
  return (
    <div className="flex flex-col gap-3" data-testid="code-reader">
      {camera ? (
        <div
          className="relative overflow-hidden rounded-xl bg-fill"
          data-camera-state={state}
          data-testid="code-camera"
          hidden={!showVideo}
        >
          <video
            aria-label="Camera"
            className="aspect-video w-full -scale-x-100 object-cover"
            muted
            playsInline
            ref={videoRef}
          />
          <p className="absolute inset-x-0 bottom-0 bg-surface/80 px-3 py-1.5 text-xs text-ink-secondary">
            Hold the iPhone’s code up to the camera.
          </p>
        </div>
      ) : null}
      {note ? (
        <p className="text-xs text-ink-secondary" data-testid="code-camera-note">
          {note}
        </p>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-secondary">
          {showVideo ? 'Or paste the code' : 'Paste the code'}
        </span>
        <textarea
          className={`${FIELD_CLASS} h-16 resize-none font-mono text-xs`}
          data-testid="code-paste"
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value);
            if (extractSettingsCode(event.target.value)) {
              void read(event.target.value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void read(text);
            }
          }}
          onPaste={(event) => {
            // Read here: a synthetic paste (the e2e's) inserts nothing.
            const pasted = event.clipboardData.getData('text/plain');
            event.preventDefault();
            setText(pasted);
            void read(pasted);
          }}
          placeholder="SOLUNIVO:1:…"
          spellCheck={false}
          value={text}
        />
      </label>
      {busy ? <p className="text-xs text-ink-secondary">Reading the code…</p> : null}
      {notice ? (
        <p className="text-sm text-danger" data-testid="code-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
