import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSessions } from '@calendar/ai/sessionLog';
import { draftCase, formatSummary, listSessions, summarize } from './sessions.ts';

/**
 * Reads an export of Keep Assistant Sessions and prints where the threads
 * were lost; with `--case <id>` it writes that thread as a draft bench
 * case, outside the repo unless `--out` says otherwise:
 *
 *   node apps/desktop/e2e/bench/sessionsReport.ts <export.jsonl> [--list]
 *   node apps/desktop/e2e/bench/sessionsReport.ts <export.jsonl> --case <id> [--lang de] [--out <dir>]
 *
 * The default folder is ~/solunivo-session-cases. A draft holds the
 * names and places that were said: replace them before it goes into
 * `cases/` (README → "A phrase from real use").
 */

const say = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const complain = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const [path] = args;

if (path === undefined || path.startsWith('--')) {
  complain(
    'usage: node apps/desktop/e2e/bench/sessionsReport.ts <export.jsonl> [--list] [--case <id> [--lang de|en] [--out <dir>]]',
  );
  process.exitCode = 2;
} else {
  const { sessions, skipped } = parseSessions(readFileSync(path, 'utf8'));
  const id = flag('--case');
  if (id === undefined) {
    say(formatSummary(summarize(sessions), skipped));
    if (args.includes('--list')) {
      say(`\n${listSessions(sessions)}`);
    }
  } else {
    const session = sessions.find((each) => each.id === id);
    const drafted =
      session === undefined
        ? undefined
        : draftCase(session, { lang: flag('--lang') === 'de' ? 'de' : 'en' });
    if (drafted === undefined) {
      complain(
        session === undefined
          ? `No session ${id} in ${path}.`
          : `Session ${id} has no turn to replay.`,
      );
      process.exitCode = 1;
    } else {
      const out = resolve(flag('--out') ?? join(homedir(), 'solunivo-session-cases'));
      mkdirSync(out, { recursive: true });
      const file = join(out, `phone-${id}.json`);
      writeFileSync(file, `${JSON.stringify(drafted, null, 2)}\n`);
      say(
        `Wrote ${file}. Replace every real name and place, fill in the earlier turns' expectations, then move it into cases/.`,
      );
    }
  }
}
