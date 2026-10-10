import { describe, expect, it } from 'vite-plus/test';
import { filterPanes, isExperimentalPane, paneFromHash, SETTINGS_PANES } from './settingsPanes.ts';

describe('filterPanes', () => {
  it('shows every pane for an empty or blank query', () => {
    expect(filterPanes('')).toEqual(SETTINGS_PANES);
    expect(filterPanes('   ')).toEqual(SETTINGS_PANES);
  });

  it('matches labels and keywords, case-folded, keeping the sidebar order', () => {
    expect(filterPanes('ACCOUNTS').map((pane) => pane.id)).toEqual(['accounts']);
    expect(filterPanes('time zone').map((pane) => pane.id)).toEqual(['general']);
    expect(filterPanes('settings file').map((pane) => pane.id)).toEqual(['file']);
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
      true,
      true,
    ]);
    expect(SETTINGS_PANES.slice(-2).map((pane) => pane.id)).toEqual(['mirrors', 'agents']);
  });
});

describe('paneFromHash', () => {
  it('names a pane only for a known id', () => {
    expect(paneFromHash('#settings/agents')).toBe('agents');
    expect(paneFromHash('#settings')).toBeNull();
    expect(paneFromHash('#settings/nope')).toBeNull();
  });
});
