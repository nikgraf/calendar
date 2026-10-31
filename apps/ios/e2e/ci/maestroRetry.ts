/**
 * Whether a failed `maestro test` run on CI may run again, and which flows.
 *
 * Four causes only, none of them the app's:
 * - The XCTest driver went away mid-run (an app main thread stuck in
 *   UIKit's keyboard queue starved its snapshot for 90 s on run
 *   38466668240). Maestro then latches the device as unreachable, and every
 *   later flow in that invocation fails within seconds. Those flows never
 *   ran, so a fresh invocation runs them once.
 * - The driver never started: Maestro gave up waiting for the runner while
 *   opening its session, before any flow, and wrote no report (runs
 *   39144942743 and 39668426261: the runner came up after Maestro's wait,
 *   or XCTest timed out waiting for accessibility). Every flow runs once
 *   more.
 * - The simulator stopped drawing the app: every screenshot Maestro took of
 *   a failed flow is solid black, while its screen hierarchy shows the app
 *   alive. The app's process gets no touch events (zero
 *   `UIKit:EventDispatch` lines for its pid on runs 39159977263 and
 *   40958072782), so a shared sub-flow's taps and retries lead nowhere and
 *   its assertion fails. Five sightings across unrelated PRs; the next
 *   flow's fresh launch drew again each time. That flow runs once more.
 * - The simulator dropped the flow's last touch: backboardd handled its
 *   touch-down and skipped later events of it, the lift included, so
 *   the app got a down and then a cancel, which is no press (run
 *   40265233306's flow 04: the check never turned, no op followed). Once
 *   in about 60 flow logs. A flow that touched or typed again after the
 *   drop went on, so its failure may be its own; only a drop at the last
 *   input counts. That flow runs once more.
 *
 * A failure the app caused (an assertion on a drawn screen, an element not
 * found, anything unknown) is never retried: it fails the job as before, so
 * a retry cannot hide an app race.
 *
 * Free of workspace imports on purpose: Node 24 runs `run-flows.ts` (and
 * this file with it) as-is, by type stripping.
 */
import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';

export type JUnitCase = {
  /** The failure text: Maestro's message, or a stack trace for other exceptions. */
  readonly failure: string | undefined;
  /** The flow file as Maestro was given it, e.g. `e2e/flows/07-create-event.yaml`. */
  readonly file: string;
  readonly name: string;
  /** Maestro's `FlowStatus`: SUCCESS, WARNING, ERROR, CANCELED, STOPPED, … */
  readonly status: string;
};

/**
 * What took a flow down: the driver died under it or never started for
 * any, or the simulator drew it black or dropped its last touch.
 */
export type RetryCause = 'black-screen' | 'died' | 'dropped-touch' | 'never-started';

export type RetryDecision =
  | { readonly kind: 'pass' }
  | {
      /** The flows to run again, in the order given, each with its cause. */
      readonly flows: ReadonlyArray<{ readonly cause: RetryCause; readonly file: string }>;
      readonly kind: 'retry';
    }
  | { readonly kind: 'fail'; readonly reason: string };

/** Statuses Maestro counts as a passed flow (WARNING: only optional steps failed). */
const PASSED = new Set(['SUCCESS', 'WARNING']);

/**
 * The driver's death in the run log: Maestro's transport gave up on the
 * XCTest server, after which it treats the device as gone.
 */
const LATCH =
  /Transport unreachable while processing|Device unreachable while processing|DeviceUnreachableException|IOSDriverTimeoutException/;

/**
 * A flow lost to that: Maestro reports any exception that is not its own
 * (`MaestroException`) as a stack trace, whose first line names the class.
 */
const UNREACHABLE_FAILURE =
  /^\s*(?:[\w.$]+\.)?(?:DeviceUnreachableException|IOSDriverTimeoutException)\b/;

/**
 * The driver's wait running out while Maestro created its session, in
 * Maestro's console output: the exception's own stack trace passes
 * `MaestroSessionManager.createMaestro`, which opens the device before the
 * first flow. `newSession` alone would not do: the flows run inside it too.
 * The run log (`maestro.log`) has only the failed status checks.
 */
const NEVER_STARTED =
  /IOSDriverTimeoutException\b[^\n]*(?:\n[ \t]+at [^\n]*)*?\n[ \t]+at maestro\.cli\.session\.MaestroSessionManager\.createMaestro\b/;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

const unescapeXml = (text: string): string =>
  text.replaceAll(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return ENTITIES[body] ?? entity;
  });

const attributesOf = (tag: string): ReadonlyMap<string, string> =>
  new Map(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key = '', value = '']) => [
      key,
      unescapeXml(value),
    ]),
  );

/** The test cases of Maestro's JUnit report (`--format junit`). */
export const parseJUnit = (xml: string): ReadonlyArray<JUnitCase> =>
  [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(
    ([, tag = '', body = '']) => {
      const attributes = attributesOf(tag);
      const failure = /<(?:failure|error)\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/.exec(
        body,
      );
      return {
        failure: failure ? unescapeXml(failure[1] ?? '') : undefined,
        file: attributes.get('file') ?? '',
        name: attributes.get('name') ?? '',
        status: attributes.get('status') ?? (failure ? 'ERROR' : 'SUCCESS'),
      };
    },
  );

/**
 * A flow's folder in Maestro's flattened debug output, which holds its
 * `screenshots/`: the flow's name with `/` made `_` (Maestro 2.10's
 * `TestDebugReporter.resolveFlowDir`; the `-shard-N` suffix it adds is for
 * Maestro's own sharding, which CI does not use). A second flow whose
 * folder already exists gets `-2`, in whichever order the flows ran, so
 * flows that share one are never told apart (see `decideRetry`).
 */
export const debugFolderName = (testCase: JUnitCase): string => testCase.name.replaceAll('/', '_');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Color samples per pixel, and whether an alpha sample follows, by PNG color type. */
const PNG_CHANNELS: Readonly<Record<number, { readonly alpha: boolean; readonly color: number }>> =
  {
    0: { alpha: false, color: 1 },
    2: { alpha: false, color: 3 },
    4: { alpha: true, color: 1 },
    6: { alpha: true, color: 3 },
  };

/** What a row filter adds back to a byte (PNG spec 9.2), from its neighbours. */
const unfilter = (filter: number, left: number, up: number, upLeft: number): number => {
  switch (filter) {
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      if (toLeft <= toUp && toLeft <= toUpLeft) {
        return left;
      }
      return toUp <= toUpLeft ? up : upLeft;
    }
    default:
      return 0;
  }
};

/**
 * Whether a PNG is solid black: every pixel's color is exactly 0, whatever
 * its alpha. A screen that stopped drawing gives exactly that, status bar
 * included (every screenshot of flow 03 on run 40958072782). A dark-mode
 * screen never does: the status bar draws on it, and the app's darkest
 * background is #19171d. Fails closed: a file it cannot read (a palette,
 * fewer than 8 bits a sample, interlacing, damage) is not black.
 */
export const isBlackPng = (png: Uint8Array): boolean => {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return false;
  }
  let header: Buffer | undefined;
  const data: Array<Buffer> = [];
  for (let offset = PNG_SIGNATURE.length; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IEND') {
      break;
    }
    if (type === 'IHDR') {
      header = body;
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  if (header === undefined || header.length < 13) {
    return false;
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth = 0, colorType = 0, , , interlace = 0] = header.subarray(8, 13);
  const channels = PNG_CHANNELS[colorType];
  if (!channels || (depth !== 8 && depth !== 16) || interlace !== 0 || width * height === 0) {
    return false;
  }
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(data));
  } catch {
    return false;
  }
  const sampleBytes = depth / 8;
  const pixelBytes = (channels.color + (channels.alpha ? 1 : 0)) * sampleBytes;
  const colorBytes = channels.color * sampleBytes;
  const stride = width * pixelBytes;
  if (pixels.length < height * (stride + 1)) {
    return false;
  }
  // Each row is stored filtered against its left and upper neighbours and
  // starts with its filter type; undo that, then look at the color bytes.
  let previous = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = pixels[start] ?? 0;
    if (filter > 4) {
      return false;
    }
    for (let x = 0; x < stride; x += 1) {
      const left = x >= pixelBytes ? (row[x - pixelBytes] ?? 0) : 0;
      const upLeft = x >= pixelBytes ? (previous[x - pixelBytes] ?? 0) : 0;
      // Modulo 256, as the spec wants: a Uint8Array keeps the low byte.
      row[x] = (pixels[start + 1 + x] ?? 0) + unfilter(filter, left, previous[x] ?? 0, upLeft);
    }
    for (let x = 0; x < stride; x += pixelBytes) {
      if (row.subarray(x, x + colorBytes).some((byte) => byte !== 0)) {
        return false;
      }
    }
    [previous, row] = [row, previous];
  }
  return true;
};

/** Every screenshot of a failed flow is black, and there is at least one. */
const blackScreen = (screenshots: ReadonlyArray<Uint8Array>): boolean =>
  screenshots.length > 0 && screenshots.every(isBlackPng);

/**
 * XCTest starting to play a command's input into the simulator, in its
 * log: once for each tap, swipe or typed text.
 */
const PLAYBACK = 'Recap event action playback initiated';

/**
 * backboardd skipping a touch's event: the touch state it looked up had no
 * record of the touch-down (on run 40265233306 it had set up two for the
 * one virtual touchscreen, logging `*** unknown digitizer`, and the down
 * went to the other).
 */
const SKIPPED_TOUCH_EVENT =
  /backboardd\[\d+\]: [^\n]*didn't see a previous touch down or range-in event for pathIndex:\d+; skipping event/;

/** backboardd handling a touch's lift: its contact left the screen. */
const TOUCH_LIFTED = /backboardd\[\d+\]: [^\n]*\bcontact \d+ presence: none\b/;

/**
 * Whether the simulator dropped the last input XCTest played into a flow,
 * from the flow's simulator log (`logs/device-simulator.log`): after the
 * last playback began, backboardd skipped events and never saw the lift.
 */
export const droppedLastTouch = (simulatorLog: string): boolean => {
  const last = simulatorLog.lastIndexOf(PLAYBACK);
  if (last === -1) {
    return false;
  }
  const playback = simulatorLog.slice(last);
  return SKIPPED_TOUCH_EVENT.test(playback) && !TOUCH_LIFTED.test(playback);
};

const passed = (testCase: JUnitCase): boolean =>
  PASSED.has(testCase.status) && testCase.failure === undefined;

/**
 * What to do after a failed run of `flows`. Fails closed: the run retries
 * only when the driver never started (no report, and the output shows the
 * session never opened), or when the report accounts for every flow and
 * every failed flow was lost to a dead driver (its death in the run log, its
 * exception in the flow's failure), to a black screen (every screenshot
 * of the flow black) or to a dropped touch (its last one, in the flow's
 * simulator log).
 */
export const decideRetry = ({
  flows,
  output,
  report,
  runLog,
  screenshots = () => [],
  simulatorLog = () => '',
}: {
  readonly flows: ReadonlyArray<string>;
  /** What Maestro printed (stdout and stderr). */
  readonly output: string;
  /** The JUnit XML; undefined when Maestro wrote none. */
  readonly report: string | undefined;
  readonly runLog: string;
  /** The PNGs Maestro saved for a flow's failed commands; none when left out. */
  readonly screenshots?: (testCase: JUnitCase) => ReadonlyArray<Uint8Array>;
  /** The simulator's log while a flow ran; empty when left out. */
  readonly simulatorLog?: (testCase: JUnitCase) => string;
}): RetryDecision => {
  if (report === undefined) {
    return NEVER_STARTED.test(output)
      ? { flows: flows.map((file) => ({ cause: 'never-started', file })), kind: 'retry' }
      : { kind: 'fail', reason: 'Maestro wrote no JUnit report' };
  }
  const cases = parseJUnit(report);
  const byFile = new Map(cases.map((testCase) => [testCase.file, testCase]));
  const missing = flows.filter((flow) => !byFile.has(flow));
  if (missing.length > 0) {
    return { kind: 'fail', reason: `the report has no result for ${missing.join(', ')}` };
  }
  const failed = flows.flatMap((flow) => {
    const testCase = byFile.get(flow);
    return testCase && !passed(testCase) ? [testCase] : [];
  });
  if (failed.length === 0) {
    return { kind: 'pass' };
  }
  const latched = LATCH.test(runLog);
  // Flows whose debug folders would collide (the runners' disk ignores
  // case): which one Maestro suffixed is unknown, so neither's screenshots
  // or logs are read as its own.
  const folders = cases.map((testCase) => debugFolderName(testCase).toLowerCase());
  const shared = new Set(folders.filter((folder, index) => folders.indexOf(folder) !== index));
  const causeOf = (testCase: JUnitCase): RetryCause | undefined => {
    if (testCase.status !== 'ERROR') {
      return undefined;
    }
    if (latched && UNREACHABLE_FAILURE.test(testCase.failure ?? '')) {
      return 'died';
    }
    if (shared.has(debugFolderName(testCase).toLowerCase())) {
      return undefined;
    }
    if (blackScreen(screenshots(testCase))) {
      return 'black-screen';
    }
    return droppedLastTouch(simulatorLog(testCase)) ? 'dropped-touch' : undefined;
  };
  const lost = failed.map((testCase) => ({ cause: causeOf(testCase), file: testCase.file }));
  const ownFailures = lost.flatMap(({ cause, file }) => (cause === undefined ? [file] : []));
  if (ownFailures.length > 0) {
    return {
      kind: 'fail',
      reason: latched
        ? `failed on their own: ${ownFailures.join(', ')}`
        : `no driver failure in the run log, no black screen and no dropped touch: ${ownFailures.join(', ')}`,
    };
  }
  return {
    flows: lost.flatMap(({ cause, file }) => (cause === undefined ? [] : [{ cause, file }])),
    kind: 'retry',
  };
};

/** The command the driver died on, from the run log (`… while processing inputText …`). */
export const latchedCommand = (runLog: string): string | undefined =>
  /(?:Transport|Device) unreachable while processing (\w+)/.exec(runLog)?.[1];
