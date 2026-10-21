/**
 * The PR Preview page's decisions, kept apart from expo-updates so they can
 * be tested. A TestFlight build asks EAS for its channel's update; the page
 * points that request at a pull request's channel (`pr-<n>`, published by
 * CI to a same-named branch) with a request-header override. expo-updates
 * saves the override on the device and applies it at every launch until
 * Back to Main clears it, so Load keeps a channel only once it runs.
 */

/**
 * The channel a TestFlight build is made for (eas.json's `testflight`
 * profile): without an override the build asks for it.
 */
export const MAIN_CHANNEL = 'main';

/** The header override that makes the build ask for `channel`. */
export const overrideFor = (channel: string): Record<string, string> | null =>
  channel === MAIN_CHANNEL ? null : { 'expo-channel-name': channel };

/**
 * The branch the running update was published to: EAS writes it into each
 * update's manifest metadata. Null for the build's own bundle, which has no
 * branch, and for a manifest without one (a dev client's from Metro).
 */
export const runningBranch = (manifest: object, isEmbeddedLaunch: boolean): string | null => {
  if (isEmbeddedLaunch || !('metadata' in manifest)) {
    return null;
  }
  const { metadata } = manifest;
  if (typeof metadata !== 'object' || metadata === null || !('branchName' in metadata)) {
    return null;
  }
  return typeof metadata.branchName === 'string' ? metadata.branchName : null;
};

/**
 * What `fetchUpdateAsync` answered: something to restart into (a new update
 * or a rollback to the build's own bundle), nothing, or an error's text.
 */
export type FetchOutcome = 'new' | 'none' | { readonly error: string };

export type LoadStep =
  /** Restart into the channel's update. */
  | { readonly kind: 'reload' }
  /** The channel already runs; keep the override. */
  | { readonly kind: 'stay'; readonly message: string }
  /** Nothing of the channel can run: put the previous channel back. */
  | { readonly kind: 'restore'; readonly message: string };

/**
 * What Load does once the fetch answered. Short of a rollback, expo-updates
 * reports nothing new only when the channel's update already runs or the
 * channel has none for this build's runtime, and a restart helps with
 * neither, so the page never asks for one.
 */
export const loadStep = ({
  fetched,
  previous,
  running,
  runtime,
  target,
}: {
  readonly fetched: FetchOutcome;
  /** The channel chosen before this Load. */
  readonly previous: string;
  /** `runningBranch`: null runs the build's own bundle, which is main as of the build. */
  readonly running: string | null;
  readonly runtime: string;
  readonly target: string;
}): LoadStep => {
  if (fetched === 'new') {
    return { kind: 'reload' };
  }
  const runs = running ?? MAIN_CHANNEL;
  if (target === MAIN_CHANNEL) {
    // Main needs no download: without the override, a relaunch runs main's
    // newest stored update, or offline the build's own bundle (the stored
    // manifest filter still names the PR's branch until main answers).
    return runs === MAIN_CHANNEL
      ? { kind: 'stay', message: 'Already on main.' }
      : { kind: 'reload' };
  }
  if (typeof fetched === 'object') {
    return {
      kind: 'restore',
      message: `Couldn't load ${target}. Still on ${previous}. ${fetched.error}`,
    };
  }
  if (runs === target) {
    return { kind: 'stay', message: `${target} is already running.` };
  }
  return {
    kind: 'restore',
    message: `${target} has no update for this build's runtime (${runtime.slice(0, 8)}). Still on ${previous}.`,
  };
};

/** The parts of expo-updates the page drives. */
export interface UpdatesApi {
  readonly fetchUpdate: () => Promise<{
    readonly isNew: boolean;
    readonly isRollBackToEmbedded: boolean;
  }>;
  readonly reload: () => Promise<void>;
  readonly setOverride: (requestHeaders: Record<string, string> | null) => void;
}

export interface Status {
  readonly failed: boolean;
  readonly text: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Load (or Back to Main, with `target` main). Answers the channel the build
 * now asks for — Back to Main can change it without a restart, so the
 * launch-time `Updates.channel` is only where it starts — and the line to
 * show, or none when the app restarts.
 */
export const switchChannel = async (
  updates: UpdatesApi,
  {
    running,
    runtime,
    saved: previous,
    target,
  }: {
    readonly running: string | null;
    readonly runtime: string;
    /** The channel the build asks for before this switch. */
    readonly saved: string;
    readonly target: string;
  },
): Promise<{ readonly saved: string; readonly status: Status | null }> => {
  let saved = previous;
  try {
    let fetched: FetchOutcome;
    try {
      updates.setOverride(overrideFor(target));
      saved = target;
      const result = await updates.fetchUpdate();
      fetched = result.isNew || result.isRollBackToEmbedded ? 'new' : 'none';
    } catch (error) {
      fetched = { error: errorText(error) };
    }
    const step = loadStep({ fetched, previous, running, runtime, target });
    if (step.kind === 'reload') {
      try {
        await updates.reload();
        return { saved, status: null };
      } catch (error) {
        // A reload picks only from stored updates, and the cache drops ones
        // older than the running update, the build's own bundle included; a
        // cold start stores that bundle again and runs the chosen channel.
        return {
          saved,
          status: {
            failed: true,
            text: `Couldn't restart. Force-quit and reopen the app to run ${target}. ${errorText(error)}`,
          },
        };
      }
    }
    if (step.kind === 'restore') {
      updates.setOverride(overrideFor(previous));
      saved = previous;
    }
    return { saved, status: { failed: step.kind === 'restore', text: step.message } };
  } catch (error) {
    return { saved, status: { failed: true, text: errorText(error) } };
  }
};
