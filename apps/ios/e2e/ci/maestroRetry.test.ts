import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { decideRetry, latchedCommand, parseJUnit } from './maestroRetry.ts';

/** Maestro 2.10's own output after its driver was killed mid-flow (stack traces trimmed). */
const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

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
      cause: 'died',
      flows: ['e2e/flows/07-create-event.yaml', 'e2e/flows/25-search.yaml'],
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
    ).toEqual({ cause: 'died', flows: [FLOWS[1], FLOWS[2]], kind: 'retry' });
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
    ).toEqual({ cause: 'never-started', flows: FLOWS, kind: 'retry' });
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
    ).toEqual({ kind: 'fail', reason: 'no driver failure in the run log' });
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
    ).toEqual({ kind: 'fail', reason: 'no driver failure in the run log' });
  });
});

describe('latchedCommand', () => {
  it('names the command the driver died on', () => {
    expect(latchedCommand(LATCHED_LOG)).toBe('inputText');
    expect(latchedCommand('')).toBeUndefined();
  });
});
