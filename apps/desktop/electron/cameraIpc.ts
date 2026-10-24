import { ipcMain, systemPreferences } from 'electron';
import { callHelper } from './helperProcess.ts';
import { isOwnPage } from './windows.ts';

/**
 * The camera, for reading a settings code the iPhone shows. Electron's
 * Chromium has no `BarcodeDetector` (the shape-detection service is not
 * built in), so the renderer streams the FaceTime camera into a `<video>`
 * itself and sends a JPEG of a frame a few times a second; the helper reads
 * QR codes in it with Vision (`barcode.readQr`).
 *
 * `CALENDAR_CAMERA`: unset, the Mac's camera; `off` (the e2e default),
 * no camera — the reader offers the paste field only and nothing asks
 * TCC; `fixture`, granted without asking, and every frame reads as
 * `CALENDAR_CAMERA_CODE` — the harness pairs it with a page-side stand-in
 * for `getUserMedia`, so a spec drives the whole reader without a camera
 * or the helper.
 */
const mode = ((): 'fixture' | 'off' | 'real' => {
  const value = process.env['CALENDAR_CAMERA'];
  return value === 'off' || value === 'fixture' ? value : 'real';
})();
const fixtureCode = process.env['CALENDAR_CAMERA_CODE'] ?? '';

/** A 1080p JPEG is well under a megabyte; anything near this cap is not a frame. */
const MAX_FRAME_BASE64_CHARS = 8_000_000;

export type CameraAccess = 'denied' | 'granted' | 'unavailable';

const trusted = (event: Electron.IpcMainInvokeEvent): boolean =>
  !!event.senderFrame && isOwnPage(event.senderFrame.url);

const askCamera = async (): Promise<CameraAccess> => {
  if (mode === 'off') {
    return 'unavailable';
  }
  if (mode === 'fixture') {
    return 'granted';
  }
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'granted') {
    return 'granted';
  }
  if (status === 'not-determined') {
    return (await systemPreferences.askForMediaAccess('camera')) ? 'granted' : 'denied';
  }
  return 'denied';
};

export const registerCameraIpc = (): void => {
  ipcMain.handle('camera:ask', (event) => {
    if (!trusted(event)) {
      throw new Error('camera: untrusted sender');
    }
    return askCamera();
  });
  ipcMain.handle('camera:read-qr', async (event, imageBase64: unknown) => {
    if (!trusted(event)) {
      throw new Error('camera: untrusted sender');
    }
    if (typeof imageBase64 !== 'string' || imageBase64.length > MAX_FRAME_BASE64_CHARS) {
      return { codes: [], error: 'invalid frame' };
    }
    if (mode === 'fixture') {
      return { codes: fixtureCode ? [fixtureCode] : [] };
    }
    if (mode === 'off') {
      return { codes: [], error: 'camera off' };
    }
    try {
      const reply = (await callHelper('barcode.readQr', { imageBase64 })) as { codes?: unknown };
      const codes = Array.isArray(reply.codes)
        ? reply.codes.filter((code): code is string => typeof code === 'string')
        : [];
      return { codes };
    } catch (error) {
      return { codes: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
};
