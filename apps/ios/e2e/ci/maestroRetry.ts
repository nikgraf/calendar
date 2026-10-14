/**
 * Whether a failed `maestro test` run on CI may run again, and which flows.
 *
 * One cause only: the XCTest driver went away mid-run (an app main thread
 * stuck in UIKit's keyboard queue starved its snapshot for 90 s on run
 * 38466668240). Maestro then latches the device as unreachable, and every
 * later flow in that invocation fails within seconds. Those flows never ran,
 * so a fresh invocation runs them once. A failure the app caused (an
 * assertion, an element not found, anything unknown) is never retried: it
 * fails the job as before, so a retry cannot hide an app race.
 *
 * Free of workspace imports on purpose: Node 24 runs `run-flows.ts` (and
 * this file with it) as-is, by type stripping.
 */

export type JUnitCase = {
  /** The failure text: Maestro's message, or a stack trace for other exceptions. */
  readonly failure: string | undefined;
  /** The flow file as Maestro was given it, e.g. `e2e/flows/07-create-event.yaml`. */
  readonly file: string;
  readonly name: string;
  /** Maestro's `FlowStatus`: SUCCESS, WARNING, ERROR, CANCELED, STOPPED, … */
  readonly status: string;
};

export type RetryDecision =
  | { readonly kind: 'pass' }
  | { readonly flows: ReadonlyArray<string>; readonly kind: 'retry' }
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

const passed = (testCase: JUnitCase): boolean =>
  PASSED.has(testCase.status) && testCase.failure === undefined;

/**
 * What to do after a failed run of `flows`. Fails closed: the run retries
 * only when the log shows the driver's death, the report accounts for every
 * flow, and every failed flow was lost to that death.
 */
export const decideRetry = ({
  flows,
  report,
  runLog,
}: {
  readonly flows: ReadonlyArray<string>;
  /** The JUnit XML; undefined when Maestro wrote none. */
  readonly report: string | undefined;
  readonly runLog: string;
}): RetryDecision => {
  if (report === undefined) {
    return { kind: 'fail', reason: 'Maestro wrote no JUnit report' };
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
  if (!LATCH.test(runLog)) {
    return { kind: 'fail', reason: 'no driver failure in the run log' };
  }
  const ownFailures = failed.filter(
    (testCase) => testCase.status !== 'ERROR' || !UNREACHABLE_FAILURE.test(testCase.failure ?? ''),
  );
  if (ownFailures.length > 0) {
    return {
      kind: 'fail',
      reason: `failed on their own: ${ownFailures.map((testCase) => testCase.file).join(', ')}`,
    };
  }
  return { flows: failed.map((testCase) => testCase.file), kind: 'retry' };
};

/** The command the driver died on, from the run log (`… while processing inputText …`). */
export const latchedCommand = (runLog: string): string | undefined =>
  /(?:Transport|Device) unreachable while processing (\w+)/.exec(runLog)?.[1];
