import { describe, expect, it } from 'vite-plus/test';
import { filterPanes, isExperimentalPane, paneFromHash, SETTINGS_PANES } from './settingsPanes.ts';

describe('filterPanes', () => {
  it('shows every pane for an empty or blank query', () => {
    expect(filterPanes('')).toEqual(SETTINGS_PANES);
    expect(filterPanes('   ')).toEqual(SETTINGS_PANES);
  });

  it('matches labels and keywords, case-folded, keeping the sidebar order', () => {
    expect(filterPanes('ACCOUNTS').map((pane) => pane.id)).toEqual(['accounts']);
    expect(filterPanes('time zone').map((pane) => pane.id)).toEqual(['timezones']);
    expect(filterPanes('ollama').map((pane) => pane.id)).toEqual(['model']);
    expect(filterPanes('privacy').map((pane) => pane.id)).toEqual(['sharing']);
    expect(filterPanes('location').map((pane) => pane.id)).toEqual(['advanced']);
    expect(filterPanes('settings file').map((pane) => pane.id)).toEqual(['file']);
    expect(filterPanes('lessons').map((pane) => pane.id)).toEqual(['gettingstarted']);
    expect(filterPanes('getting started').map((pane) => pane.id)).toEqual(['gettingstarted']);
    expect(filterPanes('import').map((pane) => pane.id)).toEqual(['file']);
    // "reminders" is both an Accounts connection and a Notifications setting.
    expect(filterPanes('reminders').map((pane) => pane.id)).toEqual(['accounts', 'notifications']);
  });

  it('needs every word, so a longer query narrows', () => {
    expect(filterPanes('reminders birthdays').map((pane) => pane.id)).toEqual(['notifications']);
    expect(filterPanes('reminders nowhere')).toEqual([]);
  });

  it('finds the experimental panes by their heading', () => {
    expect(filterPanes('experimental').map((pane) => pane.id)).toEqual(['mirrors', 'agents']);
    expect(filterPanes('experimental token').map((pane) => pane.id)).toEqual(['agents']);
  });
});

describe('isExperimentalPane', () => {
  it('lists mirrors and agents last, after every other pane', () => {
    expect(SETTINGS_PANES.map((pane) => isExperimentalPane(pane.id))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(SETTINGS_PANES.slice(-2).map((pane) => pane.id)).toEqual(['mirrors', 'agents']);
  });
});

describe('SETTINGS_PANES', () => {
  it('uses ids windows.ts accepts in settings:open: letters only', () => {
    for (const pane of SETTINGS_PANES) {
      expect(pane.id).toMatch(/^[a-z]{1,32}$/);
    }
  });
});

describe('paneFromHash', () => {
  it('names a pane only for a known id', () => {
    expect(paneFromHash('#settings/agents')).toBe('agents');
    expect(paneFromHash('#settings')).toBeNull();
    expect(paneFromHash('#settings/nope')).toBeNull();
    // General is gone: a window remembered on it falls back like any unknown id.
    expect(paneFromHash('#settings/general')).toBeNull();
  });
});
