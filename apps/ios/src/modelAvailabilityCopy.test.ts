import { describe, expect, it } from 'vite-plus/test';
import {
  availabilityDetails,
  availabilityGuidance,
  checkResultLine,
  formatCheckTime,
} from './modelAvailabilityCopy.ts';

/** 12:06:34 UTC on some day; every time here is formatted in UTC. */
const AT = Date.UTC(2026, 0, 5, 12, 6, 34);

describe('availabilityGuidance', () => {
  it('sends a disabled model to the Settings pane that switches it on', () => {
    expect(availabilityGuidance({ status: 'disabled' }, '26.0')).toContain(
      'Settings → Apple Intelligence & Siri',
    );
  });

  it('does not claim a download for a model that is not ready', () => {
    const text = availabilityGuidance({ status: 'not-ready' }, '26.0');
    expect(text).toContain('may still be downloading');
    expect(text).not.toMatch(/\bis downloading\b/);
  });

  it('names the limit an unsupported iPhone reported', () => {
    expect(availabilityGuidance({ nativeReason: 'osTooOld', status: 'unsupported' }, '18.5')).toBe(
      'Quick add needs Apple Intelligence, which needs iOS 26 or later. This iPhone runs iOS 18.5.',
    );
    expect(
      availabilityGuidance({ nativeReason: 'deviceNotEligible', status: 'unsupported' }, '26.0'),
    ).toContain("this iPhone doesn't support");
  });

  it('blames the build when the module is missing', () => {
    expect(availabilityGuidance({ status: 'missing-module' }, '26.0')).toContain(
      "This build of Solunivo doesn't include",
    );
  });

  it('says when this build cannot read the reason, and when iOS gave none it knows', () => {
    expect(
      availabilityGuidance({ reasonsUnavailable: true, status: 'unavailable' }, '26.0'),
    ).toContain("can't read why");
    expect(
      availabilityGuidance({ nativeReason: 'regionNotSupported', status: 'unavailable' }, '26.0'),
    ).toContain('without a reason Solunivo recognizes');
  });

  it('words a failed check as a check that failed, whatever status it carries', () => {
    expect(
      availabilityGuidance({ checkError: 'timed out', status: 'unavailable' }, '26.0'),
    ).toContain("couldn't find out");
  });
});

describe('checkResultLine', () => {
  it('reports an unchanged answer with the time it came', () => {
    expect(checkResultLine({ at: AT, availability: { status: 'disabled' } }, 'UTC')).toBe(
      'Still unavailable · Checked at 12:06:34 PM',
    );
  });

  it('says the check failed rather than that the model is unavailable', () => {
    expect(
      checkResultLine(
        { at: AT, availability: { checkError: 'timed out', status: 'unavailable' } },
        'UTC',
      ),
    ).toBe("Couldn't check availability · 12:06:34 PM");
  });

  it('reports a model that became ready', () => {
    expect(checkResultLine({ at: AT, availability: { status: 'ready' } }, 'UTC')).toBe(
      'Available · Checked at 12:06:34 PM',
    );
  });
});

describe('availabilityDetails', () => {
  it('lists the status, the reason as iOS named it, and the time', () => {
    expect(
      availabilityDetails(
        { nativeReason: 'appleIntelligenceNotEnabled', status: 'disabled' },
        AT,
        'UTC',
      ),
    ).toBe('Status: disabled\nNative reason: appleIntelligenceNotEnabled\nChecked at: 12:06:34 PM');
  });

  it("adds a failed check's error", () => {
    expect(availabilityDetails({ checkError: 'timed out', status: 'unavailable' }, AT, 'UTC')).toBe(
      'Status: unavailable\nNative reason: no answer\nCheck error: timed out\nChecked at: 12:06:34 PM',
    );
  });

  it('says when the build cannot read a reason, and when iOS had none', () => {
    expect(availabilityDetails({ reasonsUnavailable: true, status: 'unavailable' }, null)).toBe(
      'Status: unavailable\nNative reason: not readable in this build',
    );
    expect(availabilityDetails({ status: 'missing-module' }, null)).toBe(
      'Status: missing-module\nNative reason: none',
    );
  });
});

describe('formatCheckTime', () => {
  it('keeps the seconds, so checks a few seconds apart read as two', () => {
    expect(formatCheckTime(AT, 'UTC')).toBe('12:06:34 PM');
    expect(formatCheckTime(AT + 3000, 'UTC')).toBe('12:06:37 PM');
  });
});
