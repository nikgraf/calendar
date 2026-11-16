#!/usr/bin/env node
/**
 * The `PR complete` check (.github/workflows/pr-complete.yml): reads a PR's
 * body and files from GitHub and fails when something is still owed —
 * the user section, a review stage, a platform's screenshots or the
 * decisions record (scripts/prComplete.ts says what counts).
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/check-pr-complete.ts <number> [--ready]
 *
 * A draft, a bot's PR and one labelled `skip-pr-check` pass unchecked;
 * `--ready` checks a draft as if it were ready (before asking Nik to mark
 * it so). GITHUB_REPOSITORY defaults to nikgraf/calendar.
 */
import { appendFileSync } from 'node:fs';
import { missingParts } from './prComplete.ts';

interface PullResponse {
  readonly body: string | null;
  readonly draft: boolean;
  readonly head: { readonly ref: string };
  readonly labels: ReadonlyArray<{ readonly name: string }>;
  readonly user: { readonly type: string };
}

interface FileResponse {
  readonly filename: string;
  readonly patch?: string;
}

const SKIP_LABEL = 'skip-pr-check';

const number = Number(process.argv[2]);
if (!Number.isInteger(number) || number <= 0) {
  console.error('usage: check-pr-complete.ts <number> [--ready]');
  process.exit(2);
}
const asReady = process.argv.includes('--ready');
const repo = process.env['GITHUB_REPOSITORY'] ?? 'nikgraf/calendar';
const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? '';

const api = async <T>(path: string): Promise<T> => {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${path}: ${String(response.status)} ${await response.text()}`);
  }
  return (await response.json()) as T;
};

/** Every file of the PR; GitHub pages them 100 at a time, up to 3000. */
const allFiles = async (): Promise<ReadonlyArray<FileResponse>> => {
  const files: Array<FileResponse> = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await api<ReadonlyArray<FileResponse>>(
      `/pulls/${String(number)}/files?per_page=100&page=${String(page)}`,
    );
    files.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return files;
};

const pull = await api<PullResponse>(`/pulls/${String(number)}`);
const skip =
  pull.user.type === 'Bot'
    ? 'opened by a bot'
    : pull.labels.some(({ name }) => name === SKIP_LABEL)
      ? `labelled ${SKIP_LABEL}`
      : pull.draft && !asReady
        ? 'a draft (marking it ready runs the check)'
        : undefined;
if (skip !== undefined) {
  console.log(`#${String(number)} is ${skip}: not checked.`);
  process.exit(0);
}

const files = await allFiles();
/** The patch's added lines, split into runs wherever a context or removed line or a hunk header comes between. */
const addedRuns = (patch: string): ReadonlyArray<ReadonlyArray<string>> => {
  const runs: Array<Array<string>> = [[]];
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      runs.at(-1)?.push(line.slice(1));
    } else if ((runs.at(-1)?.length ?? 0) > 0) {
      runs.push([]);
    }
  }
  return runs.filter((run) => run.length > 0);
};

const decisionsAdded = addedRuns(
  files.find(({ filename }) => filename === 'docs/decisions.md')?.patch ?? '',
);
const missing = missingParts({
  body: pull.body ?? '',
  branch: pull.head.ref,
  decisionsAdded,
  files: files.map(({ filename }) => filename),
  number,
});

const summary = process.env['GITHUB_STEP_SUMMARY'];
if (missing.length === 0) {
  console.log(`#${String(number)} is complete.`);
  if (summary !== undefined) {
    appendFileSync(summary, `#${String(number)} is complete.\n`);
  }
  process.exit(0);
}
for (const part of missing) {
  console.log(process.env['GITHUB_ACTIONS'] === 'true' ? `::error::${part}` : `- ${part}`);
}
if (summary !== undefined) {
  appendFileSync(
    summary,
    [
      `#${String(number)} still owes:`,
      '',
      ...missing.map((part) => `- ${part}`),
      '',
      'See .agents/skills/ship-pr/SKILL.md.',
      '',
    ].join('\n'),
  );
}
process.exit(1);
