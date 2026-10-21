import { describe, expect, it } from 'vite-plus/test';
import {
  loadStep,
  overrideFor,
  runningBranch,
  switchChannel,
  type UpdatesApi,
} from './prPreview.ts';

const RUNTIME = 'f3ec89d7a97e1d2ebbe38d17f12f2b7d4fb7f3f0';

type Fetched = Parameters<typeof loadStep>[0]['fetched'];

/** Load pr-224 from main. */
const load = (fetched: Fetched, running: string | null) =>
  loadStep({ fetched, previous: 'main', running, runtime: RUNTIME, target: 'pr-224' });

/** Back to Main from pr-224. */
const back = (fetched: Fetched, running: string | null) =>
  loadStep({ fetched, previous: 'pr-224', running, runtime: RUNTIME, target: 'main' });

describe('runningBranch', () => {
  it('reads the branch EAS put in the update manifest', () => {
    expect(runningBranch({ metadata: { branchName: 'pr-224', updateGroup: 'group' } }, false)).toBe(
      'pr-224',
    );
  });

  it('has none for the build’s own bundle or a manifest without one', () => {
    expect(runningBranch({ metadata: { branchName: 'main' } }, true)).toBeNull();
    expect(runningBranch({ metadata: {} }, false)).toBeNull();
    expect(runningBranch({}, false)).toBeNull();
  });
});

describe('overrideFor', () => {
  it('clears the override for main and names any other channel', () => {
    expect(overrideFor('main')).toBeNull();
    expect(overrideFor('pr-224')).toEqual({ 'expo-channel-name': 'pr-224' });
  });
});

describe('loadStep', () => {
  it('restarts into a downloaded update', () => {
    expect(load('new', 'main')).toEqual({ kind: 'reload' });
  });

  it('says the pull request already runs instead of asking for a restart', () => {
    expect(load('none', 'pr-224')).toEqual({
      kind: 'stay',
      message: 'pr-224 is already running.',
    });
  });

  it('puts the previous channel back when the pull request has nothing for this build', () => {
    expect(load('none', 'main')).toEqual({
      kind: 'restore',
      message: "pr-224 has no update for this build's runtime (f3ec89d7). Still on main.",
    });
  });

  it('puts the previous channel back when the fetch fails', () => {
    expect(load({ error: '404: There is no channel named pr-224' }, 'main')).toEqual({
      kind: 'restore',
      message: "Couldn't load pr-224. Still on main. 404: There is no channel named pr-224",
    });
  });

  describe('back to main', () => {
    it('restarts away from a pull request even when main had nothing new or the fetch failed', () => {
      expect(back('none', 'pr-224')).toEqual({ kind: 'reload' });
      expect(back({ error: 'offline' }, 'pr-224')).toEqual({ kind: 'reload' });
    });

    it('stays when main, or the build’s own bundle, already runs', () => {
      expect(back('none', 'main')).toEqual({ kind: 'stay', message: 'Already on main.' });
      expect(back('none', null)).toEqual({ kind: 'stay', message: 'Already on main.' });
    });
  });
});

/** A stand-in for expo-updates that records each override and reload. */
const fakeUpdates = (
  fetch: () => Promise<{ isNew: boolean; isRollBackToEmbedded: boolean }>,
  reload: () => Promise<void> = async () => {},
) => {
  const calls: Array<string> = [];
  const updates: UpdatesApi = {
    fetchUpdate: fetch,
    reload: async () => {
      calls.push('reload');
      await reload();
    },
    setOverride: (headers) => {
      calls.push(headers === null ? 'override main' : `override ${headers['expo-channel-name']}`);
    },
  };
  return { calls, updates };
};

const nothing = async () => ({ isNew: false, isRollBackToEmbedded: false });

describe('switchChannel', () => {
  it('restarts into a downloaded update and keeps the new channel', async () => {
    const { calls, updates } = fakeUpdates(async () => ({
      isNew: true,
      isRollBackToEmbedded: false,
    }));
    expect(
      await switchChannel(updates, {
        running: 'main',
        runtime: RUNTIME,
        saved: 'main',
        target: 'pr-224',
      }),
    ).toEqual({ saved: 'pr-224', status: null });
    expect(calls).toEqual(['override pr-224', 'reload']);
  });

  it('restarts into a rollback like an update', async () => {
    const { calls, updates } = fakeUpdates(async () => ({
      isNew: false,
      isRollBackToEmbedded: true,
    }));
    await switchChannel(updates, {
      running: 'main',
      runtime: RUNTIME,
      saved: 'main',
      target: 'pr-224',
    });
    expect(calls).toEqual(['override pr-224', 'reload']);
  });

  it('puts the previous channel back when the pull request cannot load', async () => {
    const { calls, updates } = fakeUpdates(async () => {
      throw new Error('404: There is no channel named pr-9');
    });
    const result = await switchChannel(updates, {
      running: 'main',
      runtime: RUNTIME,
      saved: 'main',
      target: 'pr-9',
    });
    expect(result).toEqual({
      saved: 'main',
      status: {
        failed: true,
        text: "Couldn't load pr-9. Still on main. 404: There is no channel named pr-9",
      },
    });
    expect(calls).toEqual(['override pr-9', 'override main']);
  });

  it('keeps main after a Back to Main that needed no restart, so a failed Load does not bring the old pull request back', async () => {
    // The phone asks for pr-224 but runs the build's own bundle: none of
    // pr-224 was ever stored for this runtime. Back to Main finds nothing
    // newer on main and stays; the launch-time channel still says pr-224.
    const { calls, updates } = fakeUpdates(nothing);
    const back = await switchChannel(updates, {
      running: null,
      runtime: RUNTIME,
      saved: 'pr-224',
      target: 'main',
    });
    expect(back).toEqual({ saved: 'main', status: { failed: false, text: 'Already on main.' } });

    const load = await switchChannel(updates, {
      running: null,
      runtime: RUNTIME,
      saved: back.saved,
      target: 'pr-9',
    });
    expect(load.saved).toBe('main');
    expect(calls).toEqual(['override main', 'override pr-9', 'override main']);
  });

  it('keeps the new channel when the restart itself fails', async () => {
    const { updates } = fakeUpdates(
      async () => ({ isNew: true, isRollBackToEmbedded: false }),
      async () => {
        throw new Error('reload failed');
      },
    );
    expect(
      await switchChannel(updates, {
        running: 'main',
        runtime: RUNTIME,
        saved: 'main',
        target: 'pr-224',
      }),
    ).toEqual({ saved: 'pr-224', status: { failed: true, text: 'reload failed' } });
  });
});
