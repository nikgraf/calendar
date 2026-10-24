import { describe, expect, it } from 'vite-plus/test';
import { settingsEditorView } from './settingsEditor.ts';

const morning = { enabled: true, reminders: [{ leadDays: 0, time: '08:00' }] };
const evening = { enabled: true, reminders: [{ leadDays: 0, time: '20:00' }] };
const both = {
  enabled: true,
  reminders: [
    { leadDays: 0, time: '08:00' },
    { leadDays: 1, time: '08:00' },
  ],
};

describe('settingsEditorView', () => {
  it('shows the stored value until something is sent', () => {
    expect(settingsEditorView(null, morning)).toEqual({ current: morning, landed: false });
    expect(settingsEditorView(null, null)).toEqual({ current: null, landed: false });
  });

  it('keeps the last value sent while the stored one lags, so two quick saves both show', () => {
    // Sent `both` on top of `evening`; the re-read of the first save is back.
    expect(settingsEditorView(both, evening)).toEqual({ current: both, landed: false });
    expect(settingsEditorView(both, null)).toEqual({ current: both, landed: false });
  });

  it('lands once the stored value matches, whatever its key order', () => {
    // Built backwards: a decoded value's keys need not follow the sent one's.
    const reordered = Object.fromEntries([
      ['reminders', both.reminders.map((reminder) => ({ ...reminder }))],
      ['enabled', true],
    ]) as typeof both;
    expect(settingsEditorView(both, reordered)).toEqual({ current: reordered, landed: true });
  });

  it('after landing, another editor’s change to the key shows', () => {
    // The Settings page saved `morning` and it landed (the editor dropped it);
    // the Alerts lesson then saved `evening`.
    expect(settingsEditorView(null, evening).current).toBe(evening);
  });

  it('tells lists apart by order and length', () => {
    const swapped = { enabled: true, reminders: [...both.reminders].reverse() };
    expect(settingsEditorView(both, swapped).landed).toBe(false);
    expect(settingsEditorView(both, morning).landed).toBe(false);
  });
});
