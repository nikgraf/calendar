import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vite-plus/test';
import {
  debugFolderName,
  decideRetry,
  droppedLastTouch,
  isBlackPng,
  type JUnitCase,
  latchedCommand,
  parseJUnit,
} from './maestroRetry.ts';

/**
 * Maestro 2.10's own output: a report and run log after its driver was
 * killed mid-flow (stack traces trimmed), and the console of a run whose
 * driver never started.
 */
const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

/**
 * Screenshots, scaled to 201 px wide with `sips`: one Maestro took of flow
 * 03 when the simulator had stopped drawing (run 40958072782), and the
 * app's week view in dark mode (fixture data).
 */
const BLACK = readFileSync(new URL('fixtures/black-screen.png', import.meta.url));
const DARK = readFileSync(new URL('fixtures/dark-mode.png', import.meta.url));

/**
 * The XCTest and backboardd touch lines of flow 04's simulator log on run
 * 40265233306 (long lines cut): a tap on the chip's check that reached the
 * app, then the one backboardd dropped after its touch-down, the flow's
 * last input.
 */
const DROPPED = fixture('dropped-touch.device-simulator.log');
/** The same log up to the second tap: only the one that reached the app. */
const DELIVERED = DROPPED.slice(0, DROPPED.lastIndexOf('\n', DROPPED.indexOf('04:17:06.')) + 1);

/** A PNG chunk: length, type, body, CRC. */
const chunk = (type: string, body: Buffer): Buffer => {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
};

/** An 8-bit PNG of `height` rows, each pixel's samples from `pixel`, unfiltered. */
const png = ({
  colorType,
  height,
  pixel,
  width,
}: {
  readonly colorType: number;
  readonly height: number;
  readonly pixel: (x: number, y: number) => ReadonlyArray<number>;
  readonly width: number;
}): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const rows = Array.from({ length: height }, (_, y) => [
    0,
    ...Array.from({ length: width }, (__, x) => pixel(x, y)).flat(),
  ]);
  return Buffer.concat([
    BLACK.subarray(0, 8),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows.flat()))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const FLOWS = [
  'e2e/flows/03-new-event.yaml',
  'e2e/flows/07-create-event.yaml',
  'e2e/flows/09-reminders-form.yaml',
];

const UNREACHABLE = `maestro.DeviceUnreachableException: Device 22452A91 is unreachable during &apos;inputText&apos; (94000ms since last byte, connection age 360000ms): java.net.SocketTimeoutException: timeout
\tat maestro.ios.IOSDevice.runDeviceCall(IOSDevice.kt:512)`;

const testCase = (file: string, status: string, failure?: string): string =>
  `<testcase id="${file}" name="${file}" classname="${file}" file="${file}" time="12.0" status="${status}"${
    failure === undefined ? '/>' : `><failure>${failure}</failure></testcase>`
  }`;

const report = (...cases: ReadonlyArray<string>): string =>
  `<?xml version='1.0' encoding='UTF-8'?>\n<testsuites><testsuite name="Test Suite" tests="${cases.length}">${cases.join('')}</testsuite></testsuites>`;

const LATCHED_LOG =
  '21:26:01.540 [ERROR] xcuitest.XCTestDriverClient.transportCall: Transport unreachable while processing inputText, latching\n' +
  '21:26:01.719 [ERROR] device.IOSDevice.runDeviceCall: Device unreachable while processing inputText command\n';

describe('parseJUnit', () => {
  it('reads each flow with its status and unescaped failure text', () => {
    const cases = parseJUnit(
      report(
        testCase(FLOWS[0] ?? '', 'SUCCESS'),
        testCase(FLOWS[1] ?? '', 'ERROR', 'Assertion is false: &quot;Today&quot; is visible'),
      ),
    );
    expect(cases).toEqual([
      { failure: undefined, file: FLOWS[0], name: FLOWS[0], status: 'SUCCESS' },
      {
        failure: 'Assertion is false: "Today" is visible',
        file: FLOWS[1],
        name: FLOWS[1],
        status: 'ERROR',
      },
    ]);
  });
});

describe('decideRetry', () => {
  it("retries what Maestro's own report says a dead driver took down", () => {
    expect(
      decideRetry({
        flows: [
          'e2e/flows/03-new-event.yaml',
          'e2e/flows/07-create-event.yaml',
          'e2e/flows/25-search.yaml',
        ],
        output: '',
        report: fixture('driver-died.junit.xml'),
        runLog: fixture('driver-died.maestro.log'),
      }),
    ).toEqual({
      flows: [
        { cause: 'died', file: 'e2e/flows/07-create-event.yaml' },
        { cause: 'died', file: 'e2e/flows/25-search.yaml' },
      ],
      kind: 'retry',
    });
  });

  it('passes when every flow passed, warnings included', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(FLOWS[0] ?? '', 'SUCCESS'),
          testCase(FLOWS[1] ?? '', 'WARNING'),
          testCase(FLOWS[2] ?? '', 'SUCCESS'),
        ),
        runLog: '',
      }),
    ).toEqual({ kind: 'pass' });
  });

  it('retries only the flows a dead driver took down', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(FLOWS[0] ?? '', 'SUCCESS'),
          testCase(FLOWS[1] ?? '', 'ERROR', UNREACHABLE),
          testCase(
            FLOWS[2] ?? '',
            'ERROR',
            'maestro.DeviceUnreachableException: Device became unreachable during launchApp',
          ),
        ),
        runLog: LATCHED_LOG,
      }),
    ).toEqual({
      flows: [
        { cause: 'died', file: FLOWS[1] },
        { cause: 'died', file: FLOWS[2] },
      ],
      kind: 'retry',
    });
  });

  it('never retries when a flow failed on its own, even beside a dead driver', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(
            FLOWS[0] ?? '',
            'ERROR',
            'Assertion is false: id: birthday-lead-7-on is visible',
          ),
          testCase(FLOWS[1] ?? '', 'ERROR', UNREACHABLE),
          testCase(FLOWS[2] ?? '', 'ERROR', UNREACHABLE),
        ),
        runLog: LATCHED_LOG,
      }),
    ).toEqual({ kind: 'fail', reason: `failed on their own: ${FLOWS[0]}` });
  });

  it('fails on an assertion alone', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(FLOWS[0] ?? '', 'SUCCESS'),
          testCase(FLOWS[1] ?? '', 'ERROR', 'Element not found: Id matching regex: event-save'),
          testCase(FLOWS[2] ?? '', 'SUCCESS'),
        ),
        runLog: '',
      }).kind,
    ).toBe('fail');
  });

  it('fails on an unknown error or a canceled flow', () => {
    for (const lost of [
      testCase(FLOWS[1] ?? '', 'ERROR', 'Unknown error'),
      testCase(FLOWS[1] ?? '', 'CANCELED'),
    ]) {
      expect(
        decideRetry({
          flows: FLOWS,
          output: '',
          report: report(
            testCase(FLOWS[0] ?? '', 'SUCCESS'),
            lost,
            testCase(FLOWS[2] ?? '', 'SUCCESS'),
          ),
          runLog: LATCHED_LOG,
        }),
      ).toEqual({ kind: 'fail', reason: `failed on their own: ${FLOWS[1]}` });
    }
  });

  it('fails when the report misses a flow or is not there', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(FLOWS[0] ?? '', 'SUCCESS'),
          testCase(FLOWS[1] ?? '', 'ERROR', UNREACHABLE),
        ),
        runLog: LATCHED_LOG,
      }),
    ).toEqual({ kind: 'fail', reason: `the report has no result for ${FLOWS[2]}` });
    expect(
      decideRetry({ flows: FLOWS, output: '', report: undefined, runLog: LATCHED_LOG }).kind,
    ).toBe('fail');
  });

  it('retries every flow when the driver never started, as Maestro printed it', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: fixture('driver-never-started.console.log'),
        report: undefined,
        runLog: '',
      }),
    ).toEqual({
      flows: FLOWS.map((file) => ({ cause: 'never-started', file })),
      kind: 'retry',
    });
  });

  it('fails without a report when the driver timed out anywhere but session creation', () => {
    // Maestro 2.10 throws this only while creating the session, but a
    // timeout from inside a flow would also pass `newSession`, which runs
    // the flows: flows may have run (and failed on their own) before it.
    const inFlow = fixture('driver-never-started.console.log').replace(
      /\tat maestro\.cli\.session\.MaestroSessionManager\.createIOS[^\n]*\n\tat maestro\.cli\.session\.MaestroSessionManager\.createMaestro[^\n]*\n/,
      '\tat maestro.cli.runner.TestSuiteInteractor.runFlow(TestSuiteInteractor.kt:230)\n',
    );
    expect(inFlow).toContain('IOSDriverTimeoutException');
    expect(inFlow).toContain('MaestroSessionManager.newSession(');
    expect(inFlow).not.toContain('createMaestro');
    expect(decideRetry({ flows: FLOWS, output: inFlow, report: undefined, runLog: '' })).toEqual({
      kind: 'fail',
      reason: 'Maestro wrote no JUnit report',
    });
  });

  it('reads the never-started rule only when Maestro wrote no report', () => {
    // A report decides on its own: a flow that failed on its own still fails.
    expect(
      decideRetry({
        flows: FLOWS,
        output: fixture('driver-never-started.console.log'),
        report: report(
          testCase(FLOWS[0] ?? '', 'ERROR', 'Assertion is false: "Today" is visible'),
          testCase(FLOWS[1] ?? '', 'SUCCESS'),
          testCase(FLOWS[2] ?? '', 'SUCCESS'),
        ),
        runLog: '',
      }),
    ).toEqual({
      kind: 'fail',
      reason: `no driver failure in the run log, no black screen and no dropped touch: ${FLOWS[0]}`,
    });
  });

  it('fails when the run log shows no driver failure', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(FLOWS[0] ?? '', 'SUCCESS'),
          testCase(FLOWS[1] ?? '', 'ERROR', UNREACHABLE),
          testCase(FLOWS[2] ?? '', 'SUCCESS'),
        ),
        runLog: '21:24:27.365 [ INFO] maestro.Maestro.inputText: Inputting text\n',
      }),
    ).toEqual({
      kind: 'fail',
      reason: `no driver failure in the run log, no black screen and no dropped touch: ${FLOWS[1]}`,
    });
  });
});

describe('decideRetry on a black screen', () => {
  const NOT_VISIBLE = 'Assertion is false: &quot;New Event&quot; is visible';
  // One flow failed, with these screenshots; the passed ones have others.
  const run = (shots: ReadonlyArray<Uint8Array>) =>
    decideRetry({
      flows: FLOWS,
      output: '',
      report: report(
        testCase(FLOWS[0] ?? '', 'ERROR', NOT_VISIBLE),
        testCase(FLOWS[1] ?? '', 'SUCCESS'),
        testCase(FLOWS[2] ?? '', 'SUCCESS'),
      ),
      runLog: '',
      screenshots: (flow: JUnitCase) => (flow.name === FLOWS[0] ? shots : [DARK]),
    });

  it('retries a flow whose every failure screenshot is black', () => {
    expect(run([BLACK, BLACK, BLACK])).toEqual({
      flows: [{ cause: 'black-screen', file: FLOWS[0] }],
      kind: 'retry',
    });
  });

  it('fails when any screenshot of the flow drew something, dark mode included', () => {
    for (const shots of [[DARK], [BLACK, DARK, BLACK]]) {
      expect(run(shots)).toEqual({
        kind: 'fail',
        reason: `no driver failure in the run log, no black screen and no dropped touch: ${FLOWS[0]}`,
      });
    }
  });

  it('fails when the flow left no screenshot', () => {
    expect(run([]).kind).toBe('fail');
  });

  it('retries a black flow beside one the driver died under, each with its cause', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(FLOWS[0] ?? '', 'ERROR', NOT_VISIBLE),
          testCase(FLOWS[1] ?? '', 'ERROR', UNREACHABLE),
          testCase(FLOWS[2] ?? '', 'SUCCESS'),
        ),
        runLog: LATCHED_LOG,
        // A dead driver takes no screenshots.
        screenshots: (flow) => (flow.name === FLOWS[0] ? [BLACK] : []),
      }),
    ).toEqual({
      flows: [
        { cause: 'black-screen', file: FLOWS[0] },
        { cause: 'died', file: FLOWS[1] },
      ],
      kind: 'retry',
    });
  });

  it('still fails a flow that failed on a drawn screen beside a black one', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(FLOWS[0] ?? '', 'ERROR', NOT_VISIBLE),
          testCase(FLOWS[1] ?? '', 'ERROR', 'Element not found: Id matching regex: event-save'),
          testCase(FLOWS[2] ?? '', 'SUCCESS'),
        ),
        runLog: '',
        screenshots: (flow) => (flow.name === FLOWS[0] ? [BLACK] : [DARK]),
      }),
    ).toEqual({
      kind: 'fail',
      reason: `no driver failure in the run log, no black screen and no dropped touch: ${FLOWS[1]}`,
    });
  });

  it("never reads a black screen into flows whose folders collide, as Maestro can't tell them apart", () => {
    // The same folder up to case once `/` is `_`: on the runners' disk one
    // is `Opens_Settings`, the other `opens_settings-2`, in whichever order
    // the flows ran.
    const failure = `<failure>${NOT_VISIBLE}</failure>`;
    expect(
      decideRetry({
        flows: [FLOWS[0] ?? '', FLOWS[1] ?? ''],
        output: '',
        report: report(
          `<testcase name="Opens/Settings" file="${FLOWS[0]}" status="ERROR">${failure}</testcase>`,
          `<testcase name="opens_settings" file="${FLOWS[1]}" status="ERROR">${failure}</testcase>`,
        ),
        runLog: '',
        screenshots: () => [BLACK],
      }),
    ).toEqual({
      kind: 'fail',
      reason: `no driver failure in the run log, no black screen and no dropped touch: ${FLOWS[0]}, ${FLOWS[1]}`,
    });
  });

  it('never reads a passed flow as black', () => {
    // Maestro saves screenshots for commands that failed inside a retry
    // too, so a passed flow can have them.
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(FLOWS[0] ?? '', 'SUCCESS'),
          testCase(FLOWS[1] ?? '', 'WARNING'),
          testCase(FLOWS[2] ?? '', 'SUCCESS'),
        ),
        runLog: '',
        screenshots: () => [BLACK],
      }),
    ).toEqual({ kind: 'pass' });
  });
});

describe('decideRetry on a dropped touch', () => {
  const NOT_TURNED = 'Assertion is false: &quot;Reopen live-1-ios-task&quot; is visible';
  // One flow failed on a drawn screen, with this simulator log; the passed
  // ones had their taps delivered.
  const run = (log: string, status = 'ERROR') =>
    decideRetry({
      flows: FLOWS,
      output: '',
      report: report(
        testCase(FLOWS[0] ?? '', status, status === 'ERROR' ? NOT_TURNED : undefined),
        testCase(FLOWS[1] ?? '', 'SUCCESS'),
        testCase(FLOWS[2] ?? '', 'SUCCESS'),
      ),
      runLog: '',
      screenshots: () => [DARK],
      simulatorLog: (flow) => (flow.name === FLOWS[0] ? log : DELIVERED),
    });
  const ownFailure = {
    kind: 'fail',
    reason: `no driver failure in the run log, no black screen and no dropped touch: ${FLOWS[0]}`,
  };

  it('retries a flow whose last touch the simulator dropped', () => {
    expect(run(DROPPED)).toEqual({
      flows: [{ cause: 'dropped-touch', file: FLOWS[0] }],
      kind: 'retry',
    });
  });

  it('fails when the last touch reached the app', () => {
    expect(run(DELIVERED)).toEqual(ownFailure);
    expect(run('')).toEqual(ownFailure);
  });

  it('fails when the flow touched again after the drop', () => {
    // Maestro tapped once more, or the flow went on: the failure may be the
    // app's.
    expect(run(DROPPED + DELIVERED)).toEqual(ownFailure);
  });

  it('never reads a passed flow as lost to a dropped touch', () => {
    expect(run(DROPPED, 'SUCCESS')).toEqual({ kind: 'pass' });
  });

  it('reads only an errored flow as lost to a dropped touch', () => {
    expect(run(DROPPED, 'CANCELED')).toEqual(ownFailure);
  });

  it('names a black screen first when the flow also lost its last touch', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(FLOWS[0] ?? '', 'ERROR', NOT_TURNED),
          testCase(FLOWS[1] ?? '', 'SUCCESS'),
          testCase(FLOWS[2] ?? '', 'SUCCESS'),
        ),
        runLog: '',
        screenshots: () => [BLACK],
        simulatorLog: () => DROPPED,
      }),
    ).toEqual({ flows: [{ cause: 'black-screen', file: FLOWS[0] }], kind: 'retry' });
  });

  it('still fails a flow that failed on its own beside a dropped touch', () => {
    expect(
      decideRetry({
        flows: FLOWS,
        output: '',
        report: report(
          testCase(FLOWS[0] ?? '', 'ERROR', NOT_TURNED),
          testCase(FLOWS[1] ?? '', 'ERROR', 'Element not found: Id matching regex: event-save'),
          testCase(FLOWS[2] ?? '', 'SUCCESS'),
        ),
        runLog: '',
        screenshots: () => [DARK],
        simulatorLog: (flow) => (flow.name === FLOWS[0] ? DROPPED : DELIVERED),
      }),
    ).toEqual({
      kind: 'fail',
      reason: `no driver failure in the run log, no black screen and no dropped touch: ${FLOWS[1]}`,
    });
  });

  it('never reads a dropped touch into flows whose folders collide', () => {
    const failure = `<failure>${NOT_TURNED}</failure>`;
    expect(
      decideRetry({
        flows: [FLOWS[0] ?? '', FLOWS[1] ?? ''],
        output: '',
        report: report(
          `<testcase name="Opens/Settings" file="${FLOWS[0]}" status="ERROR">${failure}</testcase>`,
          `<testcase name="opens_settings" file="${FLOWS[1]}" status="ERROR">${failure}</testcase>`,
        ),
        runLog: '',
        simulatorLog: () => DROPPED,
      }).kind,
    ).toBe('fail');
  });
});

describe('droppedLastTouch', () => {
  it("reads run 40265233306's last tap as dropped and its earlier one as delivered", () => {
    expect(droppedLastTouch(DROPPED)).toBe(true);
    expect(DELIVERED).toContain('contact 2 presence: none');
    expect(DELIVERED).not.toContain('skipping event');
    expect(droppedLastTouch(DELIVERED)).toBe(false);
  });

  it('needs the lift never to have landed', () => {
    // backboardd skipping a stray event of a touch whose lift it handled.
    const lifted = DROPPED.replace(
      '\n2026-10-26 04:17:06.432223',
      '\n2026-10-26 04:17:06.431000+0000  localhost backboardd[2240]: [com.apple.BackBoard:TouchEvents] contact 2 presence: none\n2026-10-26 04:17:06.432223',
    );
    expect(lifted).not.toBe(DROPPED);
    expect(droppedLastTouch(lifted)).toBe(false);
  });

  it('needs the skipped events inside the last playback, from backboardd', () => {
    const skipped = DROPPED.split('\n').filter((line) => line.includes('skipping event'));
    expect(skipped).toHaveLength(10);
    expect(droppedLastTouch(skipped.join('\n'))).toBe(false);
    expect(droppedLastTouch(DROPPED.replaceAll('backboardd[', 'SolunivoDev['))).toBe(false);
    expect(droppedLastTouch('')).toBe(false);
  });
});

describe('isBlackPng', () => {
  it("reads Maestro's capture of a screen that stopped drawing as black", () => {
    expect(isBlackPng(BLACK)).toBe(true);
  });

  it('reads a dark-mode screenshot as not black', () => {
    expect(isBlackPng(DARK)).toBe(false);
  });

  it('looks at color only, whatever the alpha', () => {
    expect(
      isBlackPng(png({ colorType: 6, height: 4, pixel: () => [0, 0, 0, 255], width: 3 })),
    ).toBe(true);
    expect(isBlackPng(png({ colorType: 0, height: 4, pixel: () => [0], width: 3 }))).toBe(true);
  });

  it('finds the one lit pixel, however dim and however far down', () => {
    expect(
      isBlackPng(
        png({
          colorType: 2,
          height: 400,
          pixel: (x, y) => (x === 199 && y === 399 ? [0, 0, 1] : [0, 0, 0]),
          width: 200,
        }),
      ),
    ).toBe(false);
  });

  it('reads a file it cannot decode as not black', () => {
    const black = png({ colorType: 2, height: 4, pixel: () => [0, 0, 0], width: 3 });
    expect(isBlackPng(black)).toBe(true);
    expect(isBlackPng(black.subarray(0, 40))).toBe(false);
    expect(isBlackPng(Buffer.from('not a png'))).toBe(false);
    // A palette image: black or not depends on its palette, which is not read.
    expect(isBlackPng(png({ colorType: 3, height: 4, pixel: () => [0], width: 3 }))).toBe(false);
  });
});

describe('debugFolderName', () => {
  it("is the flow's name with slashes made underscores, as Maestro names the folder", () => {
    expect(
      debugFolderName({
        failure: undefined,
        file: 'e2e/flows/20-settings-file.yaml',
        name: 'Export/import the settings file',
        status: 'ERROR',
      }),
    ).toBe('Export_import the settings file');
  });
});

describe('latchedCommand', () => {
  it('names the command the driver died on', () => {
    expect(latchedCommand(LATCHED_LOG)).toBe('inputText');
    expect(latchedCommand('')).toBeUndefined();
  });
});
