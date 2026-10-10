import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  formatSettingsDocument,
  mergeSettingsDocument,
  parseSettingsDocument,
  type SettingsDocument,
  withCanonicalZones,
} from './settingsDocument.ts';

/** Parses as a device in Vienna, so a file without the device entry reads the same on every host. */
const parse = (
  text: string,
  options?: { deviceZone?: string; isValidZone?: (id: string) => boolean },
) => Effect.runSync(parseSettingsDocument(text, { deviceZone: 'Europe/Vienna', ...options }));

/** An engine whose ICU lacks the modern Kolkata name, as Hermes does. */
const hermes = (id: string) => id !== 'Asia/Kolkata';

const failure = (text: string): string => {
  const exit = Effect.runSyncExit(parseSettingsDocument(text));
  if (Exit.isSuccess(exit)) {
    throw new Error('expected a parse failure');
  }
  return String(exit.cause);
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
  birthdayReminderOverrides: [{ day: 4, displayName: 'Alice', leadDays: [14], month: 3 }],
  birthdayReminders: { enabled: true, leadDays: [0, 7], time: '08:30' },
  desktop: { screenPrivacy: 'visible' },
  eventNotifications: { enabled: false, includeAppleCalendar: true },
  timeZones: { primary: 'device', zones: ['device', 'UTC'] },
  version: 1,
  view: { allDayLaneCollapsed: true },
};

/** A document holding only a zone list. */
const zonesText = (primary: string, zones: ReadonlyArray<string>) =>
  `{ "version": 1, "timeZones": { "primary": "${primary}", "zones": ${JSON.stringify(zones)} } }`;

/** The exit of parsing a zone list on a device in Vienna. */
const parseZones = (primary: string, zones: ReadonlyArray<string>) =>
  Effect.runSyncExit(
    parseSettingsDocument(zonesText(primary, zones), { deviceZone: 'Europe/Vienna' }),
  );

describe('parseSettingsDocument', () => {
  it('accepts the minimal document', () => {
    expect(parse('{ "version": 1 }')).toEqual({ version: 1 });
  });

  it('accepts comments and trailing commas', () => {
    const text = `// header\n{\n  "version": 1, // ok\n  "view": { "allDayLaneCollapsed": true, },\n}\n`;
    expect(parse(text)).toEqual({ version: 1, view: { allDayLaneCollapsed: true } });
  });

  it('names the line of a syntax error', () => {
    expect(failure('{\n  "version": 1\n  "view": {}\n}')).toContain('line 3');
  });

  it('explains a newer version instead of a literal mismatch', () => {
    expect(failure('{ "version": 2 }')).toContain('newer Solunivo');
    expect(failure('{ "view": {} }')).toContain('"version"');
    expect(failure('[]')).toContain('JSON object');
  });

  it('rejects a zone no spelling resolves', () => {
    expect(
      failure(
        '{ "version": 1, "timeZones": { "primary": "Mars/Olympus", "zones": ["Mars/Olympus"] } }',
      ),
    ).toContain('Mars/Olympus');
  });

  it('maps zones to the spelling this engine accepts, the device entry untouched', () => {
    const text =
      '{ "version": 1, "timeZones": { "primary": "Asia/Kolkata", "zones": ["device", "Asia/Kolkata", "Asia/Calcutta", "UTC"] } }';
    expect(parse(text, { isValidZone: hermes }).timeZones).toEqual({
      primary: 'Asia/Calcutta',
      zones: ['device', 'Asia/Calcutta', 'UTC'],
    });
  });

  it('gives a file from before the device entry one: the zone this device is in, else first', () => {
    expect(parse(zonesText('Europe/Vienna', ['Europe/Vienna', 'UTC'])).timeZones).toEqual({
      primary: 'device',
      zones: ['device', 'UTC'],
    });
    expect(parse(zonesText('UTC', ['UTC', 'Asia/Kolkata'])).timeZones).toEqual({
      primary: 'UTC',
      zones: ['device', 'UTC', 'Asia/Kolkata'],
    });
    // The device spells its zone the legacy way: still the same zone.
    expect(
      parse(zonesText('Asia/Kolkata', ['Asia/Kolkata']), { deviceZone: 'Asia/Calcutta' }).timeZones,
    ).toEqual({ primary: 'device', zones: ['device'] });
    // Full, one of them this device's zone: Vienna becomes the entry, nothing is lost.
    expect(parse(zonesText('UTC', ['UTC', 'Europe/Vienna', 'Asia/Tokyo'])).timeZones).toEqual({
      primary: 'UTC',
      zones: ['UTC', 'device', 'Asia/Tokyo'],
    });
  });

  it('rejects a zone list that would lose a zone instead of trimming it', () => {
    // Full without the device's zone: adding the entry would drop Tokyo.
    expect(String(parseZones('UTC', ['UTC', 'Asia/Kolkata', 'Asia/Tokyo']))).toContain('device');
    // Longer than the cap, the device entry included or not.
    expect(Exit.isFailure(parseZones('UTC', ['device', 'UTC', 'Asia/Kolkata', 'Asia/Tokyo']))).toBe(
      true,
    );
    expect(
      Exit.isFailure(parseZones('UTC', ['UTC', 'Europe/Vienna', 'Asia/Kolkata', 'Asia/Tokyo'])),
    ).toBe(true);
  });

  it('rejects an unknown account kind and reports the path', () => {
    expect(failure('{ "version": 1, "accounts": [{ "kind": "outlook" }] }')).toContain('accounts');
  });
});

describe('formatSettingsDocument', () => {
  it('round-trips through parse and starts with the header', () => {
    const text = formatSettingsDocument(full);
    expect(text.startsWith('// Solunivo settings.')).toBe(true);
    expect(parse(text)).toEqual(full);
  });

  it('never carries a token', () => {
    expect(JSON.stringify(full)).not.toMatch(/token/i);
  });
});

describe('withCanonicalZones', () => {
  it('rewrites legacy spellings and dedupes', () => {
    expect(
      withCanonicalZones({
        timeZones: { primary: 'Asia/Calcutta', zones: ['Asia/Calcutta', 'Asia/Kolkata', 'UTC'] },
        version: 1,
      }).timeZones,
    ).toEqual({ primary: 'Asia/Kolkata', zones: ['Asia/Kolkata', 'UTC'] });
  });
});

describe('mergeSettingsDocument', () => {
  const text = [
    '// keep me',
    '{',
    '  "version": 1,',
    '  "custom": "left alone",',
    '  "timeZones": {',
    '    "primary": "UTC", // primary comment',
    '    "zones": ["device", "UTC"]',
    '  },',
    '  "accounts": [',
    '    // lost, documented',
    '    { "kind": "google", "email": "old@example.com" }',
    '  ]',
    '}',
    '',
  ].join('\n');

  it('seeds a full document from empty text', () => {
    expect(mergeSettingsDocument('   ', full)).toBe(formatSettingsDocument(full));
  });

  it('changes a leaf while keeping comments and unknown keys', () => {
    const merged = mergeSettingsDocument(text, {
      timeZones: { primary: 'UTC', zones: ['device', 'UTC', 'Asia/Kolkata'] },
      version: 1,
    });
    expect(merged).toContain('// keep me');
    expect(merged).toContain('// primary comment');
    expect(merged).toContain('"custom": "left alone"');
    expect(merged).toContain('"Asia/Kolkata"');
    expect(parse(merged).timeZones).toEqual({
      primary: 'UTC',
      zones: ['device', 'UTC', 'Asia/Kolkata'],
    });
    expect(parse(merged).accounts).toEqual([{ email: 'old@example.com', kind: 'google' }]);
  });

  it('replaces accounts as a whole and adds missing sections', () => {
    const merged = mergeSettingsDocument(text, full);
    expect(parse(merged)).toEqual({ ...full, timeZones: full.timeZones });
    expect(merged).toContain('// keep me');
    expect(merged).not.toContain('old@example.com');
  });

  it('replaces the per-person birthday list as a whole, keeping the comments around it', () => {
    const once = mergeSettingsDocument(text, full);
    const merged = mergeSettingsDocument(once, {
      birthdayReminderOverrides: [{ day: 10, displayName: 'Bob', leadDays: [], month: 3 }],
      version: 1,
    });
    expect(parse(merged).birthdayReminderOverrides).toEqual([
      { day: 10, displayName: 'Bob', leadDays: [], month: 3 },
    ]);
    expect(merged).toContain('// keep me');
    expect(merged).toContain('// primary comment');
  });

  it('is idempotent', () => {
    const once = mergeSettingsDocument(text, full);
    expect(mergeSettingsDocument(once, full)).toBe(once);
  });
});

describe('formatSettingsDocument on a runtime that rejects a canonical zone', () => {
  it('writes the document without re-validating zones', () => {
    // Hermes stores Asia/Calcutta and rejects Asia/Kolkata; the export
    // canonicalizes to Kolkata and must still produce text.
    const document = {
      timeZones: { primary: 'Mars/Olympus', zones: ['Mars/Olympus'] },
      version: 1,
    } as SettingsDocument;
    expect(() => formatSettingsDocument(document)).not.toThrow();
    expect(() => mergeSettingsDocument('{ "version": 1 }', document)).not.toThrow();
    expect(mergeSettingsDocument('{ "version": 1 }', document)).toContain('Mars/Olympus');
  });
});
