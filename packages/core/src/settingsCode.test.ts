import { Effect, Exit } from 'effect';
import { deflateSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vite-plus/test';
import type { MirrorDefinition } from './mirror/definition.ts';
import {
  base32Decode,
  base32Encode,
  decodeSettingsCode,
  describeSettingsDocument,
  encodeSettingsCode,
  extractSettingsCode,
  isSettingsCode,
  MAX_CODE_LENGTH,
  qrPathData,
  qrPng,
  settingsCodeDocument,
  settingsCodeQr,
} from './settingsCode.ts';
import type { SettingsDocument } from './settingsDocument.ts';

const decode = (text: string) => Effect.runSync(decodeSettingsCode(text));

const failure = (text: string): string => {
  const exit = Effect.runSyncExit(decodeSettingsCode(text));
  if (Exit.isSuccess(exit)) {
    throw new Error('expected a decode failure');
  }
  return String(exit.cause);
};

const mirror: MirrorDefinition = {
  busyLabel: 'Busy',
  destination: {
    calendarId: 'shared@group.calendar.google.com',
    email: 'me@example.com',
    kind: 'google',
    title: 'Shared',
  },
  fields: { description: false, location: true, title: true },
  filters: { allDay: 'copy', declined: 'skip', free: 'skip', private: 'busy' },
  id: 'mirror-1',
  monthsAhead: 3,
  name: 'Family',
  sources: [
    { calendarId: 'work@example.com', email: 'me@example.com', kind: 'google', title: 'Work' },
    { kind: 'apple', source: 'iCloud', title: 'Home' },
    { email: 'me@example.com', kind: 'googleTasks', listId: 'list-1', title: 'Inbox' },
    { kind: 'reminders', title: 'Groceries' },
  ],
  timeZone: 'Europe/Berlin',
  updatedAt: 1000,
};

const full: SettingsDocument = {
  accounts: [
    {
      calendars: [{ id: 'nik@example.com', title: 'Nik', visible: true }],
      email: 'nik@example.com',
      kind: 'google',
      taskLists: [{ id: 'list-1', title: 'Inbox', visible: false }],
    },
    { calendars: [{ source: 'iCloud', title: 'Home', visible: true }], kind: 'apple-calendar' },
    { kind: 'apple-reminders', taskLists: [{ title: 'Groceries', visible: false }] },
  ],
  birthdayReminderOverrides: [
    { day: 4, displayName: 'Alice', month: 3, reminders: [{ leadDays: 14, time: '19:00' }] },
  ],
  birthdayReminders: {
    enabled: true,
    reminders: [
      { leadDays: 0, time: '08:30' },
      { leadDays: 7, time: '18:00' },
    ],
  },
  desktop: { screenPrivacy: 'visible' },
  eventNotifications: { enabled: true, includeAppleCalendar: false },
  mirrors: [mirror],
  timeZones: { primary: 'device', zones: ['device', 'America/Los_Angeles'] },
  version: 1,
  view: { allDayLaneCollapsed: true },
};

/** A desktop spec's code; it must keep decoding as long as version 1 is read. */
const DESKTOP_FIXTURE_CODE =
  'SOLUNIVO:1:PVHM2DUCGAGH5F46BHDCWJ5Z7MCBEYXKKZT6HNUSNUIJD3G5DVA6GSLP7X5P2LUAJLE6QU4EUZNUBIJFV4YWZCBVGQIMLELYHLIAHXLAVFLOFIECYTEVEYOLHFY6JSYKKIMCSV3P3NGSY2444PAQIGMHPKVD7UNVCEYX645ONAR6LPQCOLEPNZ4EHP53K2ELQNKZ7WGRVEEMX6QFQ3AA5Q24CSNCMVSUDTHY3256T7LFCYEFXOR4I47LBXM4F55ZNSQRAWJ4GT57YAQ';

/** The code iOS flow 27 opens: only the fixture account, so the import changes nothing. */
const IOS_FLOW_CODE =
  'SOLUNIVO:1:BXEUCCUAEAIALUF37S2QI3K5OWHWQIJWZGIDTYEMCKEHPL7VDMEDCSRLU3YPWAB5QEZTYLT6VVK5UVDSFPOGKMKSQPB43ZP4HGE2ITEYQ5B2PKRMAV7J2HY';

/** Deterministic bytes, so a failing round trip reproduces. */
const bytes = (length: number, seed: number): Uint8Array => {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    out[i] = state & 255;
  }
  return out;
};

describe('base32', () => {
  it('matches the RFC 4648 vectors, without padding', () => {
    const vectors: ReadonlyArray<readonly [string, string]> = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(strToU8(plain))).toBe(encoded);
      expect(base32Decode(encoded)).toEqual(strToU8(plain));
    }
  });

  it('round-trips every length and byte value', () => {
    for (let length = 0; length <= 40; length++) {
      const data = bytes(length, length + 1);
      expect(base32Decode(base32Encode(data))).toEqual(data);
    }
  });

  it('ignores padding and refuses characters outside the alphabet', () => {
    expect(base32Decode('MZXW6===')).toEqual(strToU8('foo'));
    expect(base32Decode('MZXW1')).toBeNull();
    expect(base32Decode('mzxw6')).toBeNull();
  });
});

describe('extractSettingsCode', () => {
  const code = encodeSettingsCode({ version: 1 });

  it('finds a code wrapped, spaced or inside other text', () => {
    const payload = code.slice('SOLUNIVO:1:'.length);
    expect(extractSettingsCode(code)).toBe(code);
    expect(extractSettingsCode(`solunivo: 1 ${code}`)).toBe(code);
    expect(extractSettingsCode(`  ${code}\n`)).toBe(code);
    expect(extractSettingsCode(`SOLUNIVO:1:${payload.slice(0, 5)}\n${payload.slice(5)}`)).toBe(
      code,
    );
    expect(extractSettingsCode(`Here it is: ${code} — thanks`)).toBe(code);
    expect(extractSettingsCode(`solunivo:1:${payload}`)).toBe(code);
  });

  it('says there is none for other text', () => {
    expect(extractSettingsCode('Lunch with Sam tomorrow at 12:30')).toBeNull();
    expect(extractSettingsCode('SOLUNIVO:1:')).toBeNull();
    // A note that only starts like one: spaces in the prefix, a short payload.
    expect(extractSettingsCode('Solunivo: 2: Design review Tuesday 3pm')).toBeNull();
    expect(extractSettingsCode('Solunivo:2:Design review Tuesday 3pm')).toBeNull();
    expect(extractSettingsCode('SOLUNIVO:1:K')).toBeNull();
    // Many prefixes that come to nothing: each is looked at once, in a
    // line's time, not the rest of the text's (that was seconds).
    const started = performance.now();
    expect(extractSettingsCode('SOLUNIVO:1:\n'.repeat(40_000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(isSettingsCode('HELLO')).toBe(false);
    expect(isSettingsCode(code)).toBe(true);
  });
});

describe('encodeSettingsCode', () => {
  it('writes only characters of the QR alphanumeric set', () => {
    expect(encodeSettingsCode(full)).toMatch(/^SOLUNIVO:1:[A-Z2-7]+$/);
  });

  it('leaves out what an import never reads', () => {
    const carried = settingsCodeDocument(full);
    expect(carried.desktop).toBeUndefined();
    const [google, appleCalendar, reminders] = carried.accounts ?? [];
    expect(google).toEqual({
      calendars: [{ id: 'nik@example.com', title: '', visible: true }],
      email: 'nik@example.com',
      kind: 'google',
      taskLists: [{ id: 'list-1', title: '', visible: false }],
    });
    expect(appleCalendar).toEqual(full.accounts?.[1]);
    expect(reminders).toEqual(full.accounts?.[2]);
    const [carriedMirror] = carried.mirrors ?? [];
    expect(carriedMirror?.destination).toEqual({
      calendarId: 'shared@group.calendar.google.com',
      email: 'me@example.com',
      kind: 'google',
    });
    expect(carriedMirror?.sources).toEqual([
      { calendarId: 'work@example.com', email: 'me@example.com', kind: 'google' },
      { kind: 'apple', source: 'iCloud', title: 'Home' },
      { email: 'me@example.com', kind: 'googleTasks', listId: 'list-1' },
      { kind: 'reminders', title: 'Groceries' },
    ]);
  });

  it('round-trips through decodeSettingsCode', () => {
    expect(decode(encodeSettingsCode(full))).toEqual(settingsCodeDocument(full));
  });

  it('keeps a typical setup well inside one QR code', () => {
    // 25 calendars over three accounts: about a thousand characters.
    const many: SettingsDocument = {
      accounts: [1, 2, 3].map((n) => ({
        calendars: Array.from({ length: 8 }, (_, i) => ({
          id: `c${n}${i}calendar@group.calendar.google.com`,
          title: `Calendar ${i}`,
          visible: i % 3 !== 0,
        })),
        email: `person${n}@example.com`,
        kind: 'google' as const,
      })),
      version: 1,
    };
    const qr = Effect.runSync(settingsCodeQr(encodeSettingsCode(many)));
    expect(qr.version).toBeLessThanOrEqual(15);
  });
});

describe('decodeSettingsCode', () => {
  it('reads the committed fixture codes', () => {
    expect(decode(DESKTOP_FIXTURE_CODE)).toEqual({
      accounts: [
        {
          calendars: [
            { id: 'someone@example.com', title: '', visible: true },
            { id: 'holidays@group.v.calendar.google.com', title: '', visible: false },
          ],
          email: 'someone@example.com',
          kind: 'google',
        },
      ],
      timeZones: { primary: 'device', zones: ['device', 'America/Los_Angeles'] },
      version: 1,
    });
    expect(decode(IOS_FLOW_CODE)).toEqual({
      accounts: [{ email: 'fixture@solunivo.test', kind: 'google' }],
      version: 1,
    });
  });

  it('names what is wrong', () => {
    expect(failure('HELLO')).toContain('isn’t a Solunivo code');
    expect(failure(`SOLUNIVO:2:${'MZXW6'.repeat(4)}`)).toContain('newer Solunivo');
    expect(failure(`SOLUNIVO:0:${'MZXW6'.repeat(4)}`)).toContain('Unsupported code version 0');
    expect(failure(`SOLUNIVO:1:${base32Encode(strToU8('not deflate at all'))}`)).toContain(
      'damaged',
    );
    expect(failure(`SOLUNIVO:1:${'A'.repeat(MAX_CODE_LENGTH + 1)}`)).toContain('too long');
  });

  it('refuses a code that expands past a settings document', () => {
    const bomb = deflateSync(strToU8(' '.repeat(300 * 1024)), { level: 9 });
    expect(failure(`SOLUNIVO:1:${base32Encode(bomb)}`)).toContain('expands');
  });

  it('passes the document through the settings parser', () => {
    const code = `SOLUNIVO:1:${base32Encode(deflateSync(strToU8('{"version":1,"view":{"weekendDays":["XX"]}}')))}`;
    expect(failure(code)).toContain('weekendDays');
  });
});

describe('the QR', () => {
  const code = encodeSettingsCode(full);
  const qr = Effect.runSync(settingsCodeQr(code));

  it('carries a quiet zone of four modules', () => {
    expect(qr.size).toBe(17 + 4 * qr.version + 8);
    expect(qr.modules[3]?.some(Boolean)).toBe(false);
    expect(qr.modules[4]?.[4]).toBe(true);
  });

  it('fails past version 40', () => {
    const exit = Effect.runSyncExit(settingsCodeQr(`SOLUNIVO:1:${'A'.repeat(4000)}`));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it('leaves a setup too large for any QR to the text, which still decodes', () => {
    // 200 calendars with long random ids (seeded): deflate barely helps.
    let seed = 42;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    const id = () =>
      `${Array.from({ length: 64 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[next() % 36]).join('')}@group.calendar.google.com`;
    const large: SettingsDocument = {
      accounts: [
        {
          calendars: Array.from({ length: 200 }, (_, n) => ({
            id: id(),
            title: `Calendar ${n}`,
            visible: n % 3 !== 0,
          })),
          email: 'large@example.com',
          kind: 'google',
        },
      ],
      version: 1,
    };
    const text = encodeSettingsCode(large);
    expect(text.length).toBeGreaterThan(8000);
    expect(text.length).toBeLessThan(MAX_CODE_LENGTH);
    expect(Exit.isFailure(Effect.runSyncExit(settingsCodeQr(text)))).toBe(true);
    const decoded = Effect.runSync(decodeSettingsCode(text));
    const [decodedAccount] = decoded.accounts ?? [];
    expect(decodedAccount?.kind === 'google' ? decodedAccount.calendars : []).toHaveLength(200);
  });

  it('draws one path of runs', () => {
    const path = qrPathData(qr);
    expect(path.startsWith('M4 4h7v1h-7z')).toBe(true);
    expect(path).not.toContain('NaN');
  });

  it('writes a 1-bit PNG of the right size', () => {
    const uri = qrPng(qr, 3);
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    const png = Uint8Array.from(atob(uri.slice('data:image/png;base64,'.length)), (char) =>
      char.charCodeAt(0),
    );
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(qr.size * 3);
    expect(view.getUint32(20)).toBe(qr.size * 3);
    expect([png[24], png[25]]).toEqual([1, 0]);
  });
});

describe('describeSettingsDocument', () => {
  it('counts what the code carries, never names', () => {
    expect(describeSettingsDocument(full)).toEqual([
      '1 Google account — as a sign-in list, no passwords or tokens',
      '2 calendars and 2 task lists, shown or hidden as here',
      'Time zones: the local zone · Los Angeles',
      'Event alerts and birthday reminders',
      'Birthday notice for 1 person',
      '1 calendar mirror — arriving switched off',
    ]);
  });

  it('says nothing for an empty document', () => {
    expect(describeSettingsDocument({ version: 1 })).toEqual([]);
  });
});
