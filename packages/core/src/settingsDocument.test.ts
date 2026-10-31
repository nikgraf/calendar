import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  formatSettingsDocument,
  mergeSettingsDocument,
  parseSettingsDocument,
  type SettingsDocument,
  withCanonicalZones,
} from './settingsDocument.ts';

const parse = (text: string, options?: { isValidZone?: (id: string) => boolean }) =>
  Effect.runSync(parseSettingsDocument(text, options));

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
  eventNotifications: { enabled: false, includeAppleCalendar: true },
  taskNotifications: {
    dismissTasksWhenDone: false,
    enabled: true,
    includeAppleReminders: false,
    time: '08:30',
  },
  timeZones: { primary: 'device', zones: ['device', 'UTC'] },
  version: 1,
  view: { allDayLaneCollapsed: true, weekendDays: ['FR', 'SA'], weekendShading: true },
};

/** A document holding only a zone list. */
const zonesText = (primary: string, zones: ReadonlyArray<string>) =>
  `{ "version": 1, "timeZones": { "primary": "${primary}", "zones": ${JSON.stringify(zones)} } }`;

/** The exit of parsing a zone list. */
const parseZones = (primary: string, zones: ReadonlyArray<string>) =>
  Effect.runSyncExit(parseSettingsDocument(zonesText(primary, zones)));

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

  it('reads birthday reminders from a file written before each had its own time', () => {
    const text = JSON.stringify({
      birthdayReminderOverrides: [{ day: 4, displayName: 'Alice', leadDays: [14], month: 3 }],
      birthdayReminders: { enabled: true, leadDays: [0, 7], time: '08:30' },
      version: 1,
    });
    expect(parse(text)).toEqual({
      birthdayReminderOverrides: [
        { day: 4, displayName: 'Alice', month: 3, reminders: [{ leadDays: 14, time: '08:30' }] },
      ],
      birthdayReminders: {
        enabled: true,
        reminders: [
          { leadDays: 0, time: '08:30' },
          { leadDays: 7, time: '08:30' },
        ],
      },
      version: 1,
    });
  });

  it('rejects a zone no spelling resolves', () => {
    expect(
      failure(
        '{ "version": 1, "timeZones": { "primary": "Mars/Olympus", "zones": ["device", "Mars/Olympus"] } }',
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

  it('rejects a zone list without the device entry', () => {
    expect(failure(zonesText('UTC', ['UTC', 'Asia/Kolkata']))).toContain('device entry');
  });

  it('rejects a zone list longer than the cap', () => {
    expect(Exit.isFailure(parseZones('UTC', ['device', 'UTC', 'Asia/Kolkata', 'Asia/Tokyo']))).toBe(
      true,
    );
  });

  it('accepts a view section holding any of its fields', () => {
    expect(parse('{ "version": 1, "view": { "weekendDays": ["FR", "SA"] } }').view).toEqual({
      weekendDays: ['FR', 'SA'],
    });
    expect(parse('{ "version": 1, "view": {} }').view).toEqual({});
  });

  it('rejects a weekend day that is not a weekday code', () => {
    expect(failure('{ "version": 1, "view": { "weekendDays": ["Friday"] } }')).toContain(
      'weekendDays',
    );
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

  it('writes the weekend leaves into an existing view section', () => {
    const merged = mergeSettingsDocument(
      '{\n  "version": 1,\n  "view": {\n    "allDayLaneCollapsed": false // mine\n  }\n}\n',
      { version: 1, view: { weekendDays: ['FR', 'SA'], weekendShading: false } },
    );
    expect(merged).toContain('// mine');
    expect(parse(merged).view).toEqual({
      allDayLaneCollapsed: false,
      weekendDays: ['FR', 'SA'],
      weekendShading: false,
    });
  });

  it('replaces the per-person birthday list as a whole, keeping the comments around it', () => {
    const once = mergeSettingsDocument(text, full);
    const merged = mergeSettingsDocument(once, {
      birthdayReminderOverrides: [{ day: 10, displayName: 'Bob', month: 3, reminders: [] }],
      version: 1,
    });
    expect(parse(merged).birthdayReminderOverrides).toEqual([
      { day: 10, displayName: 'Bob', month: 3, reminders: [] },
    ]);
    expect(merged).toContain('// keep me');
    expect(merged).toContain('// primary comment');
  });

  it('writes each birthday reminder with its time and drops the old shape’s keys', () => {
    const old = [
      '{',
      '  "version": 1,',
      '  // birthdays',
      '  "birthdayReminders": { "enabled": false, "leadDays": [0], "time": "09:00" }',
      '}',
    ].join('\n');
    const merged = mergeSettingsDocument(old, full);
    expect(parse(merged).birthdayReminders).toEqual(full.birthdayReminders);
    // Only inside a reminder now: no list of lead days, no shared time.
    expect(merged).not.toMatch(/"leadDays": \[/);
    expect(merged).not.toContain('"time": "09:00"');
    expect(merged).toContain('// birthdays');
    expect(mergeSettingsDocument(merged, full)).toBe(merged);
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
