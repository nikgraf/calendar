/**
 * What a pull request must hold before it is ready to merge
 * (.agents/skills/ship-pr/SKILL.md): Nik merges a green PR that looks done,
 * so whatever is still owed has to show as a failing check, not as a note
 * in the body. `check-pr-complete.ts` runs this on GitHub's copy of a PR.
 */

export interface PullRequest {
  readonly body: string;
  /** The head branch, e.g. `todo/discard-confirm`: a record may cite it instead of the number. */
  readonly branch: string;
  /** The lines the PR adds to `docs/decisions.md`, one run per stretch of consecutive added lines. */
  readonly decisionsAdded: ReadonlyArray<ReadonlyArray<string>>;
  /** Every path the PR touches. */
  readonly files: ReadonlyArray<string>;
  readonly number: number;
}

type Platform = 'Desktop' | 'iOS';

const USER_SECTION = 'What changes for the user';

/** Files whose change a user can see, per platform; tests excluded. */
const UI_FILES: ReadonlyArray<readonly [Platform, RegExp]> = [
  ['iOS', /^apps\/ios\/(?:app|src\/ui)\//],
  ['iOS', /^brand\/tokens\//],
  ['Desktop', /^apps\/desktop\/renderer\//],
  ['Desktop', /^brand\/tokens\//],
];
const TEST_FILE = /\.test\.tsx?$/;

/** How a review section names each stage's reviewer. */
const REVIEWERS = {
  Claude: /\b(?:Claude|Opus)\b/,
  Codex: /\b(?:Codex|gpt-6)/i,
} as const;

/** Words that mean the PR still owes something (inline code aside; a `TODO` is too often a finding's subject). */
const OWED = /\b(?:[Oo]wed|[Ss]till to come)\b|\bTBD\b/;

/**
 * The part of a review line that says whose round it is: a leading bold
 * span ("**Codex (gpt-6-astra, xhigh), round 1.**") or the text before the
 * first colon ("- Codex round 2: …").
 */
const roundHead = (line: string): string => {
  const rest = line.replace(/^\s*-\s+/, '');
  return /^\*\*(.+?)\*\*/.exec(rest)?.[1] ?? rest.split(':')[0] ?? '';
};

/** A round's lead names its reviewer first; "The Opus round is pending." is no round. */
const leadsRound = (head: string): boolean =>
  /^(?:Claude|Opus|Codex|gpt-6)/i.test(head) && /\bround\b/i.test(head);

/** Text of `.github/pull_request_template.md` that a finished body has replaced. */
export const PLACEHOLDERS = [
  'One or two sentences on what this PR does.',
  'The change as the user meets it',
  'The decision.** Why. Rejected: the alternative',
  'what this PR leaves open',
  'the new and changed tests, and what each proves',
  'specs added or changed; what ran locally',
  'flows added or changed; what ran locally',
  'found … Fixed in `<sha>`',
] as const;

/** A review section's heading: one per reviewer ("After review (Codex, …)"), or one for both ("After review", "Reviews"). */
const REVIEW_HEADING = /^(?:After review|Reviews?)\b/i;

const withoutComments = (text: string): string => text.replaceAll(/<!--[\s\S]*?-->/g, '');

/** The `## ` sections in order: heading, then the text up to the next one. */
const sections = (body: string): ReadonlyArray<{ heading: string; text: string }> =>
  body
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const newline = part.indexOf('\n');
      return newline === -1
        ? { heading: part.trim(), text: '' }
        : { heading: part.slice(0, newline).trim(), text: part.slice(newline + 1) };
    });

/** The platforms whose UI files the PR touches. */
export const touchedPlatforms = (files: ReadonlyArray<string>): ReadonlyArray<Platform> => {
  const platforms = new Set<Platform>();
  for (const file of files) {
    if (TEST_FILE.test(file)) {
      continue;
    }
    for (const [platform, pattern] of UI_FILES) {
      if (pattern.test(file)) {
        platforms.add(platform);
      }
    }
  }
  return (['iOS', 'Desktop'] as const).filter((platform) => platforms.has(platform));
};

/** The words a "No … screenshot" line may name a platform by. */
const PLATFORM_NAMES: Readonly<Record<Platform, string>> = {
  Desktop: 'Desktop|Mac',
  iOS: 'iOS|iPhone',
};

/** A platform is shown by an image of its own or explained by a line that says why not. */
const shows = (section: string, platform: Platform): boolean => {
  const prefix = platform === 'iOS' ? 'ios' : 'desktop';
  return (
    new RegExp(String.raw`pr-screenshots/[^/\s"')]+/${prefix}-`, 'i').test(section) ||
    // "No iOS screenshot: …", "No iPhone shots: …", or "No screenshots: …" for every platform.
    new RegExp(String.raw`\bNo (?:(?:${PLATFORM_NAMES[platform]}) )?(?:screen)?shots?\b`, 'i').test(
      section,
    ) ||
    /\bNothing visible\b/i.test(section)
  );
};

const screenshotGaps = (pr: PullRequest, userSection: string): ReadonlyArray<string> =>
  touchedPlatforms(pr.files)
    .filter((platform) => !shows(userSection, platform))
    .map(
      (platform) =>
        `${platform} UI changed, but "${USER_SECTION}" has no ${platform} screenshot (a pr-screenshots/<branch>/${platform === 'iOS' ? 'ios' : 'desktop'}-… image) and no line "No ${platform} screenshot: <why>."`,
    );

/** The most lines a decisions record may take (AGENTS.md → Workflow). */
const RECORD_LINES = 10;

/**
 * The records the PR adds whole: a `- **` line and the indented lines
 * under it, within one run of added lines. Lines added to an existing
 * record are not a record of their own.
 */
export const addedRecords = (
  runs: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> =>
  runs.flatMap((run) => {
    const records: Array<Array<string>> = [];
    let current: Array<string> | undefined;
    for (const line of run) {
      if (line.startsWith('- **')) {
        current = [line];
        records.push(current);
      } else if (current !== undefined && /^\s+\S/.test(line)) {
        current.push(line);
      } else {
        current = undefined;
      }
    }
    return records;
  });

/** A record cites its PR by number or by branch (`todo/<slug>`), as the log has done both. */
const decisionsGaps = (pr: PullRequest, body: string): ReadonlyArray<string> => {
  const number = new RegExp(String.raw`#${String(pr.number)}(?!\d)`);
  const cites = (line: string) => number.test(line) || line.includes(`\`${pr.branch}\``);
  const cited = pr.decisionsAdded.flat().some(cites) || /\bNo decisions entry\b/i.test(body);
  return [
    ...(cited
      ? []
      : [
          `docs/decisions.md gains no line citing #${String(pr.number)} or \`${pr.branch}\`; add the record, or say "No decisions entry: <why>." in the body.`,
        ]),
    ...addedRecords(pr.decisionsAdded)
      .filter((record) => record.length > RECORD_LINES)
      .map(
        (record) =>
          `The decisions record "${/^- \*\*(.+?)\*\*/.exec(record[0] ?? '')?.[1] ?? ''}" is ${String(record.length)} lines; a record is ${String(RECORD_LINES)} at most (the mechanism goes in the doc it belongs to).`,
      ),
  ];
};

/**
 * A round marked pending ("- **Round 1** pending: usage limit", "The Opus
 * round is pending."). Only right after a round: findings here talk about
 * pending rows and ops.
 */
const NOT_RUN = /\bround(?: \d+)?\**:?\s+(?:is\s+)?pending\b/i;

/**
 * A section's text that records a round: a round named ("**Round 1** found
 * …", "Round 2 has not run; the first was clean", a second round being
 * optional), a finding listed ("- **…**", "1. **…**") or an outcome ("No
 * findings."). "Codex has not run yet." records none.
 */
const RECORDS_ROUND = /\bround\b|^\s*(?:-|\d+\.)\s+\*\*|\b(?:no findings|clean|found)\b/im;

/** Text still to be written: the template's placeholders, an empty or not-run review section, a line saying something is owed. */
const unfinished = (
  body: string,
  parts: ReadonlyArray<{ heading: string; text: string }>,
): ReadonlyArray<string> => {
  const owed = body.split('\n').find((line) => OWED.test(line.replaceAll(/`[^`]*`/g, '')));
  const reviews = parts.filter(({ heading }) => REVIEW_HEADING.test(heading));
  // The heading too: "## After review (Codex round pending)".
  const notRun = reviews
    .flatMap(({ heading, text }) => [heading, ...text.split('\n')])
    .find((line) => NOT_RUN.test(line.replaceAll(/`[^`]*`/g, '')));
  return [
    ...PLACEHOLDERS.filter((text) => body.includes(text)).map(
      (text) => `The body still holds the template's "${text}".`,
    ),
    ...reviews
      .filter(({ text }) => text.trim() === '')
      .map(({ heading }) => `"## ${heading}" is empty: say what each round found.`),
    ...(owed === undefined ? [] : [`The body says something is still owed: "${owed.trim()}"`]),
    ...(notRun === undefined
      ? []
      : [`A review section says a round has not run: "${notRun.trim()}"`]),
  ];
};

/** Everything the PR still lacks, as sentences for the check's output; empty when it is complete. */

export const missingParts = (pr: PullRequest): ReadonlyArray<string> => {
  const body = withoutComments(pr.body).replaceAll('\r\n', '\n');
  const parts = sections(body);
  const opening = body.split(/^## /m)[0]?.trim() ?? '';
  const user = parts.find(({ heading }) => heading === USER_SECTION);
  // A reviewer counts when a review section's heading names it ("## After
  // review (Claude Opus 5.5, xhigh)") and its text records a round, or a
  // round's lead line in one "## After review" / "## Reviews" section names
  // it. A mention elsewhere ("Codex has not run yet.") is no round.
  const reviews = parts.filter(({ heading }) => REVIEW_HEADING.test(heading));
  const reviewedBy = (reviewer: keyof typeof REVIEWERS) =>
    reviews.some(
      ({ heading, text }) =>
        (REVIEWERS[reviewer].test(heading) && RECORDS_ROUND.test(text)) ||
        text
          .split('\n')
          .map(roundHead)
          .some((head) => leadsRound(head) && REVIEWERS[reviewer].test(head)),
    );
  return [
    ...(opening === ''
      ? [`The body opens with a line on what the PR does, before "## ${USER_SECTION}".`]
      : []),
    ...(user === undefined
      ? [`No "## ${USER_SECTION}" section.`]
      : parts[0]?.heading === USER_SECTION
        ? []
        : [`"## ${USER_SECTION}" is the first section.`]),
    ...(user !== undefined && user.text.trim() === ''
      ? [`"## ${USER_SECTION}" is empty: a change with nothing visible says so in one line.`]
      : []),
    ...(reviewedBy('Claude')
      ? []
      : [
          'No Claude Opus round recorded: the Opus rounds are owed, in "## After review (Claude Opus …)".',
        ]),
    ...(reviewedBy('Codex')
      ? []
      : ['No Codex round recorded: at least one is owed, in "## After review (Codex …)".']),
    ...unfinished(body, parts),
    ...screenshotGaps(pr, user?.text ?? ''),
    ...decisionsGaps(pr, body),
  ];
};
