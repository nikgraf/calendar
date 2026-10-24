import { extractSettingsCode } from '@calendar/core/settingsCode';
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react';

/**
 * - idle: not asked to run.
 * - asking: waiting for macOS (the first time) or for the stream.
 * - live: frames go to the helper.
 * - denied: the person (or MDM) said no; System Settings changes it.
 * - unavailable: no camera here (CALENDAR_CAMERA=off, no device).
 * - failed: the stream or the reader broke; paste still works.
 */
export type QrCameraState = 'asking' | 'denied' | 'failed' | 'idle' | 'live' | 'unavailable';

/** How often a frame goes to the helper; Vision answers well within it. */
const FRAME_INTERVAL_MS = 250;
/** Helper failures in a row before the camera gives up and says so. */
const MAX_FAILURES = 5;

/**
 * The FaceTime camera as a settings-code reader. Electron has no
 * `BarcodeDetector`, so frames go out as JPEG to the helper's Vision
 * (`camera:read-qr`), one at a time on a timer — not on frame callbacks,
 * which stall in a window that is not in front (the e2e windows never
 * are). The first settings code in a frame goes to `onCode`; other QR
 * codes are ignored. Everything stops when `active` turns false or the
 * component unmounts. The `<video>` behind `videoRef` must stay mounted
 * while `active` (hide it, don't unmount it): the stream can be ready
 * before a state change would have rendered it.
 */
export const useQrCamera = ({
  active,
  onCode,
}: {
  active: boolean;
  onCode: (code: string) => void;
}): { state: QrCameraState; videoRef: RefObject<HTMLVideoElement | null> } => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<QrCameraState>('idle');
  const found = useEffectEvent((code: string) => onCode(code));

  useEffect(() => {
    if (!active) {
      return;
    }
    let stopped = false;
    let stream: MediaStream | null = null;
    let attached: HTMLVideoElement | null = null;
    let timer: number | undefined;
    const canvas = document.createElement('canvas');
    // The camera off: its light goes out with the tracks.
    const release = () => {
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      stream = null;
      if (attached) {
        attached.srcObject = null;
        attached = null;
      }
    };

    const readFrame = async (video: HTMLVideoElement, failures: number) => {
      if (stopped) {
        return;
      }
      let next = failures;
      if (video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d')?.drawImage(video, 0, 0);
        const frame = canvas.toDataURL('image/jpeg', 0.85).slice('data:image/jpeg;base64,'.length);
        const reply = await window.calendarBridge.cameraReadQr(frame);
        if (stopped) {
          return;
        }
        const code = reply.codes.map(extractSettingsCode).find((value) => value !== null);
        if (code) {
          found(code);
        }
        next = reply.error ? failures + 1 : 0;
        if (next >= MAX_FAILURES) {
          // Given up: nothing reads the frames any more, so the camera stops too.
          release();
          setState('failed');
          return;
        }
      }
      timer = window.setTimeout(() => void readFrame(video, next), FRAME_INTERVAL_MS);
    };

    const start = async () => {
      setState('asking');
      const access = await window.calendarBridge.cameraAsk();
      if (stopped) {
        return;
      }
      if (access !== 'granted') {
        setState(access);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { height: { ideal: 1080 }, width: { ideal: 1920 } },
        });
      } catch {
        if (!stopped) {
          setState('failed');
        }
        return;
      }
      const video = videoRef.current;
      if (stopped || !video) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        // No element to show it in: the caller must keep the <video> mounted.
        if (!stopped) {
          setState('failed');
        }
        return;
      }
      attached = video;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      if (stopped) {
        return;
      }
      setState('live');
      void readFrame(video, 0);
    };

    void start();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      release();
    };
  }, [active]);

  return { state: active ? state : 'idle', videoRef };
};
