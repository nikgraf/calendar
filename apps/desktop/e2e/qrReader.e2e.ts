import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SettingsDocument } from '@calendar/core';
import { encodeSettingsCode, qrPng, settingsCodeQr } from '@calendar/core/settingsCode';
import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

// The Mac's settings-code reader depends on the helper: Electron's
// Chromium has no BarcodeDetector, so the renderer sends camera frames and
// the helper reads them with Vision (`barcode.readQr`). This proves Vision
// reads the QR the settings code draws. Needs the built helper — CI runs
// it in the job that builds it; the default e2e run skips it.
const REAL = process.env['CALENDAR_E2E_HELPER'] === 'real';

const HELPER = join(
  import.meta.dirname,
  '..',
  'helper',
  '.build',
  'release',
  'solunivo-model-helper',
);

/** One stdio request to the helper, the way the app itself talks to it. */
const callHelper = (method: string, params: Record<string, unknown>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const child = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`helper ${method}: no answer`));
    }, 15_000);
    lines.on('line', (line) => {
      const message = JSON.parse(line) as { error?: string; id?: number; result?: unknown };
      if (message.id !== 1) {
        return;
      }
      clearTimeout(timer);
      child.kill();
      if (message.error) {
        reject(new Error(`helper ${method}: ${message.error}`));
      } else {
        resolve(message.result);
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method, params })}\n`);
  });

const PNG_PREFIX = 'data:image/png;base64,';

/** Three Google accounts with 24 calendars: a typical code, about QR version 15. */
const typical: SettingsDocument = {
  accounts: [1, 2, 3].map((n) => ({
    calendars: Array.from({ length: 8 }, (_, i) => ({
      id: `c${n}${i}calendar@group.calendar.google.com`,
      title: `Calendar ${i}`,
      visible: i % 3 !== 0,
    })),
    email: `person${n}@example.com`,
    kind: 'google' as const,
  })),
  timeZones: { primary: 'device', zones: ['device', 'America/Los_Angeles'] },
  version: 1,
};

describe.skipIf(!REAL)('the helper reads settings codes', () => {
  it('reads the QR a settings code draws, down to two pixels a module', async () => {
    const code = encodeSettingsCode(typical);
    const qr = Effect.runSync(settingsCodeQr(code));
    for (const scale of [2, 4]) {
      const reply = await callHelper('barcode.readQr', {
        imageBase64: qrPng(qr, scale).slice(PNG_PREFIX.length),
      });
      expect(reply).toEqual({ codes: [code] });
    }
  });

  it('finds nothing in a frame without a code', async () => {
    const blank = { modules: Array.from({ length: 40 }, () => Array(40).fill(false)), size: 40 };
    const reply = await callHelper('barcode.readQr', {
      imageBase64: qrPng({ ...blank, version: 1 }, 4).slice(PNG_PREFIX.length),
    });
    expect(reply).toEqual({ codes: [] });
  });

  it('refuses bytes that are not an image', async () => {
    await expect(callHelper('barcode.readQr', { imageBase64: 'bm90IGFuIGltYWdl' })).rejects.toThrow(
      /barcode/,
    );
  });
});
