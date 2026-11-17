import { describe, expect, it } from 'vite-plus/test';
import {
  dueForSample,
  mainThreadLine,
  mainThreadSummary,
  observe,
  pagingLine,
  vmStat,
  type Waiting,
} from './stallWatch.ts';

/** `log stream --style compact` lines of one XCTest request, as the app logs them. */
const line = (message: string, pid = 61_011, time = '09:39:26.239'): string =>
  `2026-11-17 ${time} Df SolunivoDev[${pid}:71778] [com.apple.dt.xctest:Default] XCTPerformOnMainRunLoop${message}`;
const ASKED = line('[not MT]: about to CFRunLoopPerform');
const WAITING = line('[not MT]: waiting with 30.00s responsiveness timeout');
const ANSWERED = line('[MT]: inside CFRunLoopPerform');

describe('mainThreadLine', () => {
  it('reads the request and its start on the main thread, with the pid', () => {
    const logged = Date.parse('2026-11-17T09:39:26.239Z');
    expect(mainThreadLine(ASKED)).toEqual({ kind: 'asked', logged, pid: 61_011 });
    expect(mainThreadLine(ANSWERED)).toEqual({ kind: 'answered', logged, pid: 61_011 });
  });

  it('ignores the waiting line and other processes', () => {
    expect(mainThreadLine(WAITING)).toBeUndefined();
    expect(mainThreadLine(ASKED.replace('SolunivoDev[61011', 'SpringBoard[1822'))).toBeUndefined();
  });
});

/** Feeds lines (with their arrival time, ms) through `observe`, sampling what is due at `sampleAt`. */
const run = (lines: ReadonlyArray<readonly [string, number]>, sampleAt?: number) => {
  let waiting: ReadonlyMap<number, Waiting> = new Map();
  const stalls = [];
  for (const [text, now] of lines) {
    if (sampleAt !== undefined && now > sampleAt) {
      for (const pid of dueForSample(waiting, sampleAt, 2000)) {
        const open = waiting.get(pid);
        if (open) {
          waiting = new Map(waiting).set(pid, { ...open, sampled: true });
        }
      }
    }
    const parsed = mainThreadLine(text);
    if (parsed) {
      const next = observe(waiting, parsed, now);
      waiting = next.waiting;
      if (next.stall) {
        stalls.push(next.stall);
      }
    }
  }
  return { stalls, waiting };
};

describe('observe', () => {
  it('times a wait from the request, even when the main thread starts before the waiting line', () => {
    // A quick main thread logs `inside` before XCTest logs `waiting`; the next
    // request's `inside` must not end this one (run 44036785186 looked like
    // 2 s waits that way).
    const { stalls, waiting } = run([
      [ASKED, 0],
      [ANSWERED, 1],
      [WAITING, 2],
      [ASKED, 2200],
      [WAITING, 2201],
      [ANSWERED, 2210],
    ]);
    expect(stalls).toEqual([]);
    expect(waiting.size).toBe(0);
  });

  it('reports a sampled request when the main thread finally starts it, timed by the app', () => {
    const { stalls } = run(
      [
        [ASKED, 1000],
        [WAITING, 1001],
        [line('[MT]: inside CFRunLoopPerform', 61_011, '09:39:42.657'), 17_500],
      ],
      3500,
    );
    expect(stalls).toEqual([{ arrivalSeconds: 16.5, pid: 61_011, seconds: 16.418, since: 1000 }]);
  });

  it('tells a late delivery from a stall: the app answered at once', () => {
    // The log stream held the answer back 13 s (run 44076498121 had such waits
    // with the main thread idle and serving XCTest throughout the sample).
    const { stalls } = run(
      [
        [ASKED, 1000],
        [line('[MT]: inside CFRunLoopPerform', 61_011, '09:39:26.290'), 14_000],
      ],
      3500,
    );
    expect(stalls).toEqual([{ arrivalSeconds: 13, pid: 61_011, seconds: 0.051, since: 1000 }]);
  });

  it('reports nothing for a wait that was never sampled', () => {
    expect(
      run([
        [ASKED, 0],
        [ANSWERED, 2500],
      ]).stalls,
    ).toEqual([]);
  });

  it('keeps the requests of two processes apart', () => {
    const { waiting } = run([
      [ASKED, 0],
      [line('[not MT]: about to CFRunLoopPerform', 7), 10],
      [ANSWERED, 20],
    ]);
    expect([...waiting.keys()]).toEqual([7]);
  });
});

describe('dueForSample', () => {
  it('names a request once it has waited the threshold, and only until it is sampled', () => {
    const waiting = new Map<number, Waiting>([
      [1, { logged: undefined, sampled: false, since: 0 }],
      [2, { logged: undefined, sampled: false, since: 1500 }],
      [3, { logged: undefined, sampled: true, since: 0 }],
    ]);
    expect(dueForSample(waiting, 2000, 2000)).toEqual([1]);
  });
});

/**
 * The main thread of a `sample` report (iOS 26.5 simulator, the View menu
 * opening; frames cut): mostly idle in its run loop, partly in a gesture.
 */
const REPORT = `Call graph:
    741 Thread_40634538: Main Thread   DispatchQueue_<multiple>
    + 741 start  (in dyld) + 6652  [0x104f4dd7c]
    +   741 start_sim  (in dyld_sim) + 20  [0x1050930e4]
    +     741 main  (in SolunivoDev) + 116  [0x1022efd98]
    +       741 ???  (in UIKitCore)  load address 0x185289000 + 0x3c1820  [0x18564a820]
    +         741 UIApplicationMain  (in UIKitCore) + 120  [0x186b9f910]
    +           741 -[UIApplication _run]  (in UIKitCore) + 776  [0x1864a54cc]
    +             741 GSEventRunModal  (in GraphicsServices) + 116  [0x1933599c0]
    +               741 _CFRunLoopRunSpecificWithOptions  (in CoreFoundation) + 496  [0x18041c904]
    +                 138 __CFRunLoopRun  (in CoreFoundation) + 2100  [0x180421d44]
    +                 ! 136 __CFRunLoopDoSource1  (in CoreFoundation) + 476  [0x180422c78]
    +                 ! : 87 ???  (in Gestures)  load address 0x1dd53d000 + 0x7b43c  [0x1dd5b843c]
    +                 584 __CFRunLoopRun  (in CoreFoundation) + 1128  [0x180421978]
    +                 ! 584 __CFRunLoopServiceMachPort  (in CoreFoundation) + 156  [0x1804227c0]
    +                 !   584 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x105554b5c]
    7 Thread_40634540   DispatchQueue_2: com.apple.libdispatch-manager  (serial)
    + 7 _dispatch_mgr_thread  (in libdispatch.dylib) + 140  [0x1803cd1d0]
`;

describe('mainThreadSummary', () => {
  it('gives the idle share and follows the busiest frame below the run loop, idle wait left out', () => {
    expect(mainThreadSummary(REPORT)).toEqual({
      idle: 79,
      path: [
        ' 19% __CFRunLoopRun  (CoreFoundation)',
        ' 18% __CFRunLoopDoSource1  (CoreFoundation)',
        ' 12% ??? (Gestures + 0x7b43c)',
      ],
    });
  });

  it('keeps a thread blocked outside its run loop in the path', () => {
    const blocked = REPORT.replace(
      '584 __CFRunLoopServiceMachPort  (in CoreFoundation) + 156  [0x1804227c0]',
      '584 _pthread_mutex_firstfit_lock_wait  (in libsystem_pthread.dylib) + 84  [0x1804227c0]',
    );
    expect(mainThreadSummary(blocked)?.path.slice(0, 2)).toEqual([
      ' 79% __CFRunLoopRun  (CoreFoundation)',
      ' 79% _pthread_mutex_firstfit_lock_wait  (libsystem_pthread.dylib)',
    ]);
  });

  it('finds a main thread named only by its queue, as sample does on CI', () => {
    const ci = REPORT.replace(
      'Thread_40634538: Main Thread   DispatchQueue_<multiple>',
      'Thread_66217   DispatchQueue_1: com.apple.main-thread  (serial)',
    );
    expect(mainThreadSummary(ci)?.idle).toBe(79);
  });

  it('is undefined for a report without a main thread', () => {
    expect(mainThreadSummary('Call graph:\n')).toBeUndefined();
  });
});

/** `vm_stat` on a macOS host (counters cut to the ones read). */
const VM_STAT = (
  pageins: number,
  free: number,
): string => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     ${free}.
Pages active:                                 511185.
File-backed pages:                            65536.
Pages stored in compressor:                  12800.
"Translation faults":                    21033631845.
Pageins:                                   ${pageins}.
Pageouts:                                     753658.
Swapins:                                   110.
Swapouts:                                  122.
`;

describe('vmStat and pagingLine', () => {
  it('reads the paging counters and says what a sample saw paged in', () => {
    const before = vmStat(VM_STAT(1000, 6400));
    const after = vmStat(VM_STAT(7400, 3200));
    expect(before).toEqual({
      compressed: 12_800,
      fileBacked: 65_536,
      free: 6400,
      pageins: 1000,
      pageSize: 16_384,
      swapins: 110,
    });
    expect(before && after && pagingLine(before, after)).toBe(
      'host paging during the sample: 100 MB paged in, 0 MB swapped in; then 50 MB free, 1024 MB file-backed, 200 MB compressed',
    );
  });

  it('is undefined when a counter is missing', () => {
    expect(vmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\n')).toBeUndefined();
  });
});
