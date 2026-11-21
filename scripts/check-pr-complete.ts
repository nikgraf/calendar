#!/usr/bin/env node
/**
 * The `PR complete` check (.github/workflows/pr-complete.yml): reads a PR's
 * body and files from GitHub and fails when something is still owed —
 * the user section, a review stage, a platform's screenshots or the
 * decisions record (scripts/prComplete.ts says what counts).
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/check-pr-complete.ts <number> [--ready] [--status]
 *
 * A draft, a bot's PR and one labelled `skip-pr-check` pass unchecked;
 * `--ready` checks a draft as if it were ready (before asking Nik to mark
 * it so). `--status` (the workflow's) posts the verdict as the `PR
 * complete` commit status on the PR's head and exits 0 either way: a later
 * status under that name replaces it, while a failed run's own check would
 * stay on the commit. GITHUB_REPOSITORY defaults to nikgraf/calendar.
 */
import { appendFileSync } from 'node:fs';
import {
  type CompleteStatus,
  completeStatus,
  missingParts,
  verdictInputsChanged,
} from './prComplete.ts';

interface PullResponse {
  readonly body: string | null;
  readonly draft: boolean;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly labels: ReadonlyArray<{ readonly name: string }>;
  readonly user: { readonly type: string };
}

interface FileResponse {
  readonly filename: string;
  readonly patch?: string;
}

const SKIP_LABEL = 'skip-pr-check';
/** The commit status's name, which the workflow's job is not: its own check always passes. */
const STATUS_CONTEXT = 'PR complete';

const number = Number(process.argv[2]);
const asReady = process.argv.includes('--ready');
const postsStatus = process.argv.includes('--status');
const repo = process.env['GITHUB_REPOSITORY'] ?? 'nikgraf/calendar';
const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? '';

const headers = {
  Accept: 'application/vnd.github+json',
  ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
  'X-GitHub-Api-Version': '2022-11-28',
};

const api = async <T>(path: string): Promise<T> => {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GET ${path}: ${String(response.status)} ${await response.text()}`);
  }
  return (await response.json()) as T;
};

/** The run that posted it, when on GitHub Actions: the status links there for the full list. */
const runUrl = (): string | undefined => {
  const runId = process.env['GITHUB_RUN_ID'];
  return runId === undefined
    ? undefined
    : `${process.env['GITHUB_SERVER_URL'] ?? 'https://github.com'}/${repo}/actions/runs/${runId}`;
};

/** Sets the `PR complete` status on `sha`. */
const postStatus = async (sha: string, status: CompleteStatus): Promise<void> => {
  const target = runUrl();
  const response = await fetch(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
    body: JSON.stringify({
      context: STATUS_CONTEXT,
      description: status.description,
      state: status.state,
      ...(target === undefined ? {} : { target_url: target }),
    }),
    headers,
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`POST /statuses/${sha}: ${String(response.status)} ${await response.text()}`);
  }
  console.log(`Posted "${STATUS_CONTEXT}" ${status.state} on ${sha}: ${status.description}`);
};

const readPull = () => api<PullResponse>(`/pulls/${String(number)}`);

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

type Verdict = { readonly missing: ReadonlyArray<string> } | { readonly skipped: string };

/** Why the PR goes unchecked, or what it still lacks, from one read of it. */
const evaluate = async (pull: PullResponse): Promise<Verdict> => {
  const skip =
    pull.user.type === 'Bot'
      ? 'opened by a bot'
      : pull.labels.some(({ name }) => name === SKIP_LABEL)
        ? `labelled ${SKIP_LABEL}`
        : pull.draft && !asReady
          ? 'a draft (marking it ready runs the check)'
          : undefined;
  if (skip !== undefined) {
    return { skipped: skip };
  }
  const files = await allFiles();
  const decisionsAdded = addedRuns(
    files.find(({ filename }) => filename === 'docs/decisions.md')?.patch ?? '',
  );
  return {
    missing: missingParts({
      body: pull.body ?? '',
      branch: pull.head.ref,
      decisionsAdded,
      files: files.map(({ filename }) => filename),
      number,
    }),
  };
};

/** Prints the verdict (and the step summary on Actions); true when the PR still lacks something. */
const report = (verdict: Verdict): boolean => {
  if ('skipped' in verdict) {
    console.log(`#${String(number)} is ${verdict.skipped}: not checked.`);
    return false;
  }
  const { missing } = verdict;
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (missing.length === 0) {
    console.log(`#${String(number)} is complete.`);
    if (summary !== undefined) {
      appendFileSync(summary, `#${String(number)} is complete.\n`);
    }
    return false;
  }
  for (const part of missing) {
    // An annotation only where the run itself fails: with --status the job
    // passes, and the status carries the verdict.
    console.log(
      process.env['GITHUB_ACTIONS'] === 'true' && !postsStatus ? `::error::${part}` : `- ${part}`,
    );
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
  return true;
};

/** How many times a run posts again because the PR kept changing under it; later runs carry on. */
const MAX_POSTS = 5;

/**
 * Posts the verdict, then reads the PR again: if what the verdict was read
 * from changed meanwhile, it evaluates and posts again. Runs overlap now
 * that none is cancelled, and a stalled run's older post can land after a
 * newer run's (green over an unfinished body, too); the last post to land
 * is then one whose run saw the PR unchanged after it, or a run started by
 * a later change posts after it.
 */
const postUntilSettled = async (first: PullResponse, firstVerdict: Verdict): Promise<void> => {
  let read = first;
  let verdict = firstVerdict;
  for (let post = 1; post <= MAX_POSTS; post++) {
    await postStatus(read.head.sha, completeStatus(verdict));
    const now = await readPull();
    if (!verdictInputsChanged(read, now)) {
      return;
    }
    console.log(`#${String(number)} changed while this run checked it: checking again.`);
    read = now;
    verdict = await evaluate(read);
    report(verdict);
  }
  console.log(
    `#${String(number)} kept changing: the runs its changes started post after this one.`,
  );
};

/** The exit code: 0 when complete, unchecked or posted as a status; 1 when something is owed; 2 on a bad call. */
const check = async (): Promise<number> => {
  if (!Number.isInteger(number) || number <= 0) {
    console.error('usage: check-pr-complete.ts <number> [--ready] [--status]');
    return 2;
  }
  const pull = await readPull();
  const verdict = await evaluate(pull);
  // Printed before the post, so a post that fails still leaves it in the log.
  const lacking = report(verdict);
  if (!postsStatus) {
    return lacking ? 1 : 0;
  }
  await postUntilSettled(pull, verdict);
  return 0;
};

// The exit code, not process.exit: output still on its way down a pipe is kept.
process.exitCode = await check();
