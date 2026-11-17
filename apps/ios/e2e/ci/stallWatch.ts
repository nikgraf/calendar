/**
 * Catches the app's main thread not answering XCTest during a Maestro run,
 * and samples the app while it still does not.
 *
 * Every hierarchy query and tap Maestro sends ends in XCTest asking the
 * app's main run loop to run a block: the app logs
 * `XCTPerformOnMainRunLoop[not MT]: about to CFRunLoopPerform`, then, once
 * the main thread runs it, `[MT]: inside CFRunLoopPerform`. On CI that wait
 * has lasted 16 s (run 44045125095), long enough to fail a flow's 5 s wait,
 * while the same step answers within 0.2 s on a developer's Mac, so only a
 * sample taken on the runner, during the wait, says what the main thread
 * is doing. The `[not MT]: waiting with … timeout` line can come after
 * `inside` when the main thread is quick, so a wait is timed from `about
 * to`, never from `waiting`.
 */

/** One XCTest line of the app's log: a request to the main thread, or its start there. */
export interface MainThreadLine {
  readonly kind: 'asked' | 'answered';
  readonly pid: number;
}

/**
 * The XCTest main-run-loop line in one line of `log stream` output (any
 * style that keeps `<process>[<pid>` in front of the message), if it is one.
 */
export const mainThreadLine = (line: string): MainThreadLine | undefined => {
  const pid = /SolunivoDev\[(\d+)/.exec(line)?.[1];
  if (pid === undefined || !line.includes('XCTPerformOnMainRunLoop')) {
    return undefined;
  }
  if (line.includes('about to CFRunLoopPerform')) {
    return { kind: 'asked', pid: Number(pid) };
  }
  if (line.includes('inside CFRunLoopPerform')) {
    return { kind: 'answered', pid: Number(pid) };
  }
  return undefined;
};

/** A request the main thread has not started yet: since when, and whether it was sampled. */
export interface Waiting {
  readonly sampled: boolean;
  readonly since: number;
}

/** A request the main thread started only after a sample was taken. */
export interface Stall {
  readonly pid: number;
  readonly seconds: number;
  readonly since: number;
}

/**
 * The waiting requests after `line` (read at `now`, ms), and the stall it
 * ends, if any. A process has one request at a time: a new `asked` while one
 * waits replaces it (XCTest gave up on the old one).
 */
export const observe = (
  waiting: ReadonlyMap<number, Waiting>,
  line: MainThreadLine,
  now: number,
): { readonly stall: Stall | undefined; readonly waiting: ReadonlyMap<number, Waiting> } => {
  const next = new Map(waiting);
  if (line.kind === 'asked') {
    next.set(line.pid, { sampled: false, since: now });
    return { stall: undefined, waiting: next };
  }
  const open = next.get(line.pid);
  next.delete(line.pid);
  return {
    stall:
      open?.sampled === true
        ? { pid: line.pid, seconds: (now - open.since) / 1000, since: open.since }
        : undefined,
    waiting: next,
  };
};

/** The processes whose request has waited `thresholdMs` without a sample yet. */
export const dueForSample = (
  waiting: ReadonlyMap<number, Waiting>,
  now: number,
  thresholdMs: number,
): ReadonlyArray<number> =>
  [...waiting].flatMap(([pid, open]) =>
    !open.sampled && now - open.since >= thresholdMs ? [pid] : [],
  );

/** The frames every main-thread stack starts with: left out of a printed path. */
const RUN_LOOP_PREFIX =
  /^(start|start_sim|main|\?\?\? \(UIKitCore|UIApplicationMain|-\[UIApplication _run\]|GSEventRunModal|_CFRunLoopRunSpecific)/;

/** One frame of a `sample` call graph, without addresses. */
const frameName = (raw: string): string =>
  raw
    .replaceAll(/\s+\[0x[0-9a-f]+(,0x[0-9a-f]+)*\]/g, '')
    .replace(
      /^\?\?\?\s+\(in ([^)]+)\)\s+load address 0x[0-9a-f]+ \+ (0x[0-9a-f]+)/,
      '??? ($1 + $2)',
    )
    .replace(/\s+\(in ([^)]+)\)\s+\+\s+\d+$/, '  ($1)')
    .trim();

/** Where an idle main thread waits: its run loop's own `mach_msg`. */
const IDLE = /^__CFRunLoopServiceMachPort\b/;

/**
 * The main thread in a `sample` report: the share of its samples it sat idle
 * in its run loop, and its heaviest busy path — from the run loop down, at
 * each level the frame most of the other samples were in, with its share.
 * A sample starts a while into a stall and may outlast it, so the idle time
 * after the stall is left out of the path rather than drowning it. A thread
 * blocked anywhere else (a lock, a synchronous IPC) stays in the path.
 * `undefined` when the report has no main thread.
 */
export const mainThreadSummary = (
  report: string,
): { readonly idle: number; readonly path: ReadonlyArray<string> } | undefined => {
  const lines = report.split('\n');
  const head = lines.findIndex((line) => /^\s+\d+ Thread_\d+.*Main Thread/.test(line));
  if (head === -1) {
    return undefined;
  }
  const total = Number(/^\s+(\d+)/.exec(lines[head] ?? '')?.[1] ?? 0);
  const nodes: Array<{ count: number; depth: number; frame: string }> = [];
  for (const line of lines.slice(head + 1)) {
    const node = /^(\s+[+!:| ]*)(\d+) (.+)$/.exec(line);
    if (!node || /^\s+\d+ Thread_/.test(line)) {
      break;
    }
    nodes.push({
      count: Number(node[2]),
      depth: (node[1] ?? '').length,
      frame: frameName(node[3] ?? ''),
    });
  }
  // Each node's samples outside the run loop's idle wait: an idle wait
  // counts against every frame above it.
  const busy = nodes.map((node) => node.count);
  const stack: Array<number> = [];
  for (const [index, node] of nodes.entries()) {
    while (stack.length > 0 && (nodes[stack.at(-1) ?? 0]?.depth ?? 0) >= node.depth) {
      stack.pop();
    }
    if (IDLE.test(node.frame)) {
      busy[index] = 0;
      for (const ancestor of stack) {
        busy[ancestor] = (busy[ancestor] ?? 0) - node.count;
      }
    }
    stack.push(index);
  }
  const path: Array<{ count: number; frame: string }> = [];
  let index: number | undefined = 0;
  while (index !== undefined && index < nodes.length) {
    const here = nodes[index];
    if (here === undefined) {
      break;
    }
    path.push({ count: busy[index] ?? 0, frame: here.frame });
    // The next level is the first deeper line; of its lines, the one with most samples.
    const level = nodes[index + 1]?.depth;
    let best: number | undefined;
    for (let child = index + 1; child < nodes.length; child++) {
      const node = nodes[child];
      if (node === undefined || level === undefined || node.depth <= here.depth) {
        break;
      }
      if (
        node.depth === level &&
        (busy[child] ?? 0) > 0 &&
        (best === undefined || (busy[child] ?? 0) > (busy[best] ?? 0))
      ) {
        best = child;
      }
    }
    index = best;
  }
  const share = (count: number): number => (total > 0 ? Math.round((100 * count) / total) : 0);
  const below = path.findIndex((node) => !RUN_LOOP_PREFIX.test(node.frame));
  return {
    idle: share(
      nodes.filter((node) => IDLE.test(node.frame)).reduce((sum, node) => sum + node.count, 0),
    ),
    path: path
      .slice(below === -1 ? path.length : below)
      .map(({ count, frame }) => `${String(share(count)).padStart(3)}% ${frame}`),
  };
};
