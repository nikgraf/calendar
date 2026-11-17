import { File, Paths } from 'expo-file-system';
import { loadLaunchTimingModule } from '../modules/solunivo-launch-timing/index.ts';
import {
  type LaunchRecord,
  type LaunchStep,
  parseLaunches,
  reachStep,
  startLaunch,
} from './launchTimes.ts';

/**
 * Records this launch's steps into the app's documents directory, each as
 * it is reached: a launch closed while it hung leaves the steps it got to
 * (see `launchTimes.ts`). Imported by `index.ts` right after the polyfill,
 * so its evaluation is when the app's JavaScript started.
 *
 * Nothing is recorded for a reload (the bundle runs again in the same
 * process, PR Preview's Load), a launch in the background (a background
 * task's), or a binary without the native module.
 */
const scriptStarted = Date.now();

const FILE_NAME = 'launch-times.json';

const file = () => new File(Paths.document, FILE_NAME);

export const readLaunchTimes = (): ReadonlyArray<LaunchRecord> => {
  try {
    const target = file();
    return target.exists ? parseLaunches(target.textSync()) : [];
  } catch {
    return [];
  }
};

/** The records this launch writes, once it was taken; undefined for one not recorded. */
let records: ReadonlyArray<LaunchRecord> | undefined;

const write = (next: ReadonlyArray<LaunchRecord>) => {
  records = next;
  try {
    // Synchronous: a launch closed right after this step keeps it.
    file().writeSync(JSON.stringify(next));
  } catch {
    // A record that cannot be written must never get in a launch's way.
  }
};

const launch = loadLaunchTimingModule()?.take();
if (launch) {
  write(startLaunch(readLaunchTimes(), launch, 'script', scriptStarted));
}

/** This launch reached `step`: kept the first time only. */
export const markLaunch = (step: LaunchStep): void => {
  if (!records) {
    return;
  }
  const next = reachStep(records, step, Date.now());
  if (next !== records) {
    write(next);
  }
};
