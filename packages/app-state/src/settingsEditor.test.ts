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
    expect(settingsEditorView(null, morning, 0)).toEqual({ current: morning, landed: false });
    expect(settingsEditorView(null, null, 0)).toEqual({ current: null, landed: false });
  });

  it('keeps the last value sent while the stored one lags, so two quick saves both show', () => {
    // Sent `both` on top of `evening`; the re-read of the first save is back.
    expect(settingsEditorView(both, evening, 1)).toEqual({ current: both, landed: false });
    expect(settingsEditorView(both, null, 1)).toEqual({ current: both, landed: false });
  });

  it('lands once the stored value matches, whatever its key order', () => {
    // Built backwards: a decoded value's keys need not follow the sent one's.
    const reordered = Object.fromEntries([
      ['reminders', both.reminders.map((reminder) => ({ ...reminder }))],
      ['enabled', true],
    ]) as typeof both;
    expect(settingsEditorView(both, reordered, 0)).toEqual({ current: reordered, landed: true });
  });

  it('after landing, another editor’s change to the key shows', () => {
    // The Settings page saved `morning` and it landed (the editor dropped it);
    // the Alerts lesson then saved `evening`.
    expect(settingsEditorView(null, evening, 0).current).toBe(evening);
  });

  it('holds an undone change until every save is back', () => {
    // Ticked (sent `both`), then unticked at once (sent `morning` again)
    // while `morning` is still stored: matching, but the tick's re-read
    // is yet to come and would show it ticked.
    expect(settingsEditorView(morning, morning, 2)).toEqual({ current: morning, landed: false });
    expect(settingsEditorView(morning, both, 1)).toEqual({ current: morning, landed: false });
    expect(settingsEditorView(morning, morning, 0)).toEqual({ current: morning, landed: true });
  });

  it('tells lists apart by order and length', () => {
    const swapped = { enabled: true, reminders: [...both.reminders].reverse() };
    expect(settingsEditorView(both, swapped, 0).landed).toBe(false);
    expect(settingsEditorView(both, morning, 0).landed).toBe(false);
  });
});
