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

/** What `fetchUpdateAsync` answered: a new update, nothing to load, or an error's text. */
export type FetchOutcome = 'new' | 'none' | { readonly error: string };

export type LoadStep =
  /** Restart into the channel's update. */
  | { readonly kind: 'reload' }
  /** The channel already runs; keep the override. */
  | { readonly kind: 'stay'; readonly message: string }
  /** Nothing of the channel can run: put the previous channel back. */
  | { readonly kind: 'restore'; readonly message: string };

/**
 * What Load does once the fetch answered. expo-updates reports nothing new
 * only when the channel's update already runs or the channel has none for
 * this build's runtime, and a restart helps with neither, so the page
 * never asks for one.
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
    // newest stored update or the build's own bundle, offline too.
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
