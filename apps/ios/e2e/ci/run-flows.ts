#!/usr/bin/env node
/**
 * Runs Maestro flows on CI and runs them once more, in a fresh invocation,
 * when the XCTest driver died under them or never started — never for a
 * failure the app caused (see maestroRetry.ts for the rule). Each attempt's
 * report, logs and console output (`console.log`) go to
 * ~/.maestro/tests/<label>-<attempt>, which the diagnostics upload already
 * collects.
 *
 *   node e2e/ci/run-flows.ts <label> <flow>...     (SIMULATOR_UDID set)
 *
 * With E2E_APP (the .app CI installed) the second run starts on an erased
 * simulator with a fresh install of it; without, nothing is reset (a
 * developer's simulator and dev client keep their data).
 *
 * e2e/ci/package.json marks these files as ES modules for Node: the app's
 * own package.json is part of the native fingerprint.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { decideRetry, latchedCommand } from './maestroRetry.ts';

/** The dev variant: e2e always drives it (prepare-simulator.sh). */
const BUNDLE_ID = 'com.solunivo.app.dev';

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const [label, ...flows] = process.argv.slice(2);
const udid = process.env['SIMULATOR_UDID'];
if (!label || flows.length === 0 || !udid) {
  process.stderr.write('usage: SIMULATOR_UDID=… run-flows.ts <label> <flow>...\n');
  process.exit(2);
}

/** Every file under `dir` whose name `matches`, depth-first. */
const filesUnder = (dir: string, matches: (name: string) => boolean): ReadonlyArray<string> =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          return filesUnder(path, matches);
        }
        return matches(entry.name) ? [path] : [];
      })
    : [];

const readAll = (paths: ReadonlyArray<string>): string =>
  paths.map((path) => readFileSync(path, 'utf8')).join('\n');

/**
 * One `maestro test` invocation; its exit status and output folder. What it
 * prints still streams to the job log and is copied to `console.log`: a
 * driver that never started shows only there.
 */
const attempt = async (number: number, attemptFlows: ReadonlyArray<string>) => {
  const dir = join(homedir(), '.maestro', 'tests', `${label}-${number}`);
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  const report = join(dir, 'report.xml');
  const output = join(dir, 'console.log');
  const copy = createWriteStream(output);
  const child = spawn(
    'maestro',
    [
      'test',
      '--device',
      udid,
      '--format',
      'junit',
      '--output',
      report,
      // The run's log, the XCTest runner's log and each flow's folder, all
      // in `dir`: unflattened, the run's log lands in a hidden
      // `.maestro/tests/<timestamp>` that the diagnostics upload skips.
      '--debug-output',
      dir,
      '--flatten-debug-output',
      ...attemptFlows,
    ],
    { stdio: ['inherit', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    copy.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    copy.write(chunk);
  });
  const [code] = (await once(child, 'close')) as [number | null];
  copy.end();
  await once(copy, 'close');
  return { dir, output, report, status: code ?? 1 };
};

const summary = (line: string): void => {
  const file = process.env['GITHUB_STEP_SUMMARY'];
  if (file) {
    appendFileSync(file, `${line}\n`);
  }
};

/**
 * The run, answering the exit code. The process ends on its own with it:
 * on a pipe, stdout and stderr write asynchronously, and `process.exit`
 * would drop Maestro's last output still queued for the job log.
 */
const main = async (): Promise<number> => {
  const first = await attempt(1, flows);
  if (first.status === 0) {
    return 0;
  }

  // The run log (and each flow's copy of it) says whether the driver died.
  const runLog = readAll(filesUnder(first.dir, (name) => name === 'maestro.log'));
  const decision = decideRetry({
    flows,
    output: readFileSync(first.output, 'utf8'),
    report: existsSync(first.report) ? readFileSync(first.report, 'utf8') : undefined,
    runLog,
  });
  if (decision.kind !== 'retry') {
    say(
      decision.kind === 'pass'
        ? 'maestro failed, but every flow passed'
        : `no retry: ${decision.reason}`,
    );
    return first.status;
  }

  const retried = decision.flows.join(', ');
  summary(`### Maestro retry (${label})`);
  if (decision.cause === 'never-started') {
    say(`::warning::The Maestro driver never started; running ${retried} again`);
    summary(
      `The XCTest driver never started. Ran again: ${decision.flows.map((flow) => `\`${flow}\``).join(', ')}.`,
    );
  } else {
    const command = latchedCommand(runLog) ?? 'unknown';
    // XCTest's own account of why it lost the app: a main thread that would
    // not answer is the app hanging (or starved), not Maestro.
    const mainThreadBusy = /main thread busy/.test(
      readAll(filesUnder(first.dir, (name) => /xctest/i.test(name) && name.endsWith('.log'))),
    );
    say(
      `::warning::The Maestro driver died during ${command}${
        mainThreadBusy ? ' (XCTest: app main thread busy)' : ''
      }; running ${retried} again`,
    );
    summary(
      `The XCTest driver died during \`${command}\`${
        mainThreadBusy ? ', after XCTest found the app main thread busy' : ''
      }. Ran again: ${decision.flows.map((flow) => `\`${flow}\``).join(', ')}.`,
    );
  }

  // A hung app or a half-dead runner must not carry into the next invocation.
  for (const bundle of ['dev.mobile.maestro-driver-iosUITests.xctrunner', BUNDLE_ID]) {
    spawnSync('xcrun', ['simctl', 'terminate', udid, bundle], { stdio: 'ignore' });
  }
  // The flow the driver died in stopped halfway: what it had changed (a
  // primary time zone in the app's data, a reminder in the device's
  // EventKit) would break its own first check. On CI the second run starts
  // from an erased simulator with the app installed and set up again, as
  // the first did.
  const app = process.env['E2E_APP'];
  if (app) {
    const prepared = spawnSync(
      'bash',
      [fileURLToPath(new URL('prepare-simulator.sh', import.meta.url)), 'reset', app],
      { stdio: 'inherit' },
    );
    if (prepared.status !== 0) {
      say('::error::resetting the simulator for the second run failed');
      return first.status;
    }
  }

  const second = await attempt(2, decision.flows);
  summary(second.status === 0 ? 'The second run passed.' : 'The second run failed too.');
  return second.status;
};

process.exitCode = await main();
