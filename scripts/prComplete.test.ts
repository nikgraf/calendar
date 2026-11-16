import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  addedRecords,
  missingParts,
  PLACEHOLDERS,
  type PullRequest,
  touchedPlatforms,
} from './prComplete.ts';

const shot = (file: string) =>
  `<img width="300" src="https://github.com/nikgraf/calendar/blob/pr-screenshots/todo-x/${file}?raw=true">`;

const body = (userSection: string, rest = '') => `Closing an edited editor asks first.

## What changes for the user

${userSection}

## Decisions

- **One gate.** Every way off the panel goes through it.

## Tests

- **Gate:** green.

## After review (Claude Opus 5.5, xhigh)

- **Round 1** found nothing.

## After review (Codex, gpt-6-astra, xhigh)

- **Round 1** found nothing.
${rest}`;

const complete: PullRequest = {
  body: body(
    '- **Cancel asks first (iOS, Desktop).** Before, it dropped the draft.\n\nNothing visible: …',
  ),
  branch: 'todo/discard-confirm',
  decisionsAdded: [['- **Closing an edited editor asks first** (#333): …']],
  files: ['packages/core/src/editor.ts'],
  number: 333,
};

/** A decisions record of this many lines. */
const record = (lines: number) => [
  '- **Closing an edited editor asks first** (#333) — the editor',
  ...Array.from(
    { length: lines - 1 },
    (_, line) => `  compares its form, line ${String(line + 2)}.`,
  ),
];

describe('missingParts', () => {
  it('passes a complete PR', () => {
    expect(missingParts(complete)).toEqual([]);
  });

  it('wants the user section first, after an opening line', () => {
    expect(
      missingParts({
        ...complete,
        body: complete.body.replace('Closing an edited editor asks first.\n', ''),
      }),
    ).toEqual([
      'The body opens with a line on what the PR does, before "## What changes for the user".',
    ]);
    const decisionsFirst = complete.body.replace(
      '## What changes for the user',
      '## Decisions\n\n- x\n\n## What changes for the user',
    );
    expect(missingParts({ ...complete, body: decisionsFirst })).toEqual([
      '"## What changes for the user" is the first section.',
    ]);
    expect(
      missingParts({
        ...complete,
        body: complete.body.replace('## What changes for the user', '## Summary'),
      }),
    ).toEqual(['No "## What changes for the user" section.']);
  });

  it('wants both review stages', () => {
    const noCodex = complete.body.replace(/## After review \(Codex[\s\S]*$/, '');
    expect(missingParts({ ...complete, body: noCodex })).toEqual([
      'No "## After review (Codex …)" section: at least one Codex round is owed.',
    ]);
    const noClaude = complete.body.replace('## After review (Claude Opus 5.5, xhigh)', '## Notes');
    expect(missingParts({ ...complete, body: noClaude })).toEqual([
      'No "## After review (Claude Opus …)" section: the Opus rounds are owed.',
    ]);
  });

  it('takes one review section that names both reviewers', () => {
    const together = complete.body.replace(
      /## After review \(Claude[\s\S]*$/,
      '## After review\n\n**Claude Opus 5.5 (xhigh), round 1.** All fixed.\n\n**Codex (gpt-6-astra, xhigh), round 1.** Clean.\n',
    );
    expect(missingParts({ ...complete, body: together })).toEqual([]);
    const opusOnly = together.replace(/\*\*Codex[^\n]*\n/, '');
    expect(missingParts({ ...complete, body: opusOnly })).toEqual([
      'No "## After review (Codex …)" section: at least one Codex round is owed.',
    ]);
    // A reviewer named outside a review section does not count.
    expect(
      missingParts({ ...complete, body: `${opusOnly}\n## Tests again\n\nCodex ran nothing.\n` }),
    ).toHaveLength(1);
  });

  it('fails a body that keeps the template’s placeholders or an empty review section', () => {
    const template = readFileSync(
      join(import.meta.dirname, '..', '.github', 'pull_request_template.md'),
      'utf8',
    );
    // Both ways, so a template edit can't leave the check behind: every
    // placeholder is the template's, and every template line to replace
    // (outside comments, not a heading, not the Gate line one keeps) has one.
    for (const text of PLACEHOLDERS) {
      expect(template).toContain(text);
    }
    const toReplace = template
      .replaceAll(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#') && !line.includes('**Gate:**'));
    for (const line of toReplace) {
      expect(
        PLACEHOLDERS.some((text) => line.includes(text)),
        line,
      ).toBe(true);
    }
    expect(
      missingParts({ ...complete, body: template, files: [] }).filter((part) =>
        part.startsWith('The body still holds'),
      ),
    ).toHaveLength(PLACEHOLDERS.length);
    const emptyCodex = complete.body.replace(/(## After review \(Codex[^\n]*\n)[\s\S]*$/, '$1\n');
    expect(missingParts({ ...complete, body: emptyCodex })).toEqual([
      '"## After review (Codex, gpt-6-astra, xhigh)" is empty: say what each round found.',
    ]);
  });

  it('counts a reviewer only by a heading or a round that names it', () => {
    const together = (lines: string) =>
      complete.body.replace(/## After review \(Claude[\s\S]*$/, `## After review\n\n${lines}\n`);
    // The forms older PRs used.
    for (const lines of [
      '- **Opus (xhigh), round 1:** ten findings.\n- **Codex gpt-6-astra (xhigh), round 1:** one.',
      '**Claude Opus 5.5 (xhigh) and Codex (gpt-6-astra, xhigh), round 1.** All fixed.',
      '- Opus-level self round (xhigh): 11 findings, all fixed.\n- Codex round 2: 5 P2, all fixed.',
    ]) {
      expect(missingParts({ ...complete, body: together(lines) })).toEqual([]);
    }
    // A mention is no round.
    expect(
      missingParts({
        ...complete,
        body: together('**Claude Opus 5.5 (xhigh), round 1.** Clean. Codex has not run yet.'),
      }),
    ).toEqual([
      'No "## After review (Codex …)" section: at least one Codex round is owed.',
      'A review section says a round has not run: "**Claude Opus 5.5 (xhigh), round 1.** Clean. Codex has not run yet."',
    ]);
    const codexOnly = complete.body.replace(
      /## After review \(Claude[\s\S]*$/,
      '## After review (Codex, gpt-6-astra, xhigh)\n\n- **Round 1** found nothing. The Opus round is pending.\n',
    );
    expect(missingParts({ ...complete, body: codexOnly })).toEqual([
      'No "## After review (Claude Opus …)" section: the Opus rounds are owed.',
      'A review section says a round has not run: "- **Round 1** found nothing. The Opus round is pending."',
    ]);
  });

  it('fails a review section that says a round has not run', () => {
    const codexSays = (line: string) =>
      complete.body.replace(/(## After review \(Codex[^\n]*\n\n)[\s\S]*$/, `$1${line}\n`);
    for (const line of [
      'Codex has not run yet.',
      '- **Round 1** pending: usage limit until 15:00.',
      'The round is pending.',
    ]) {
      expect(missingParts({ ...complete, body: codexSays(line) })).toEqual([
        `A review section says a round has not run: "${line}"`,
      ]);
    }
    // A round not taken is the author's call (1–2 Opus rounds).
    expect(
      missingParts({
        ...complete,
        body: codexSays('- **Round 1** clean. I did not run a second round: the first was clean.'),
      }),
    ).toEqual([]);
    // Findings about pending rows and ops are findings.
    expect(
      missingParts({
        ...complete,
        body: codexSays('- **Round 1** found a pending row left with no op. Fixed.'),
      }),
    ).toEqual([]);
  });

  it('fails a body that says something is still owed', () => {
    // The line REVIEW.md tells an author to write when Codex hit its limit.
    const limit = complete.body.replace(
      /(## After review \(Codex[^\n]*\n\n)[\s\S]*$/,
      '$1Codex round owed: usage limit until 15:00.\n',
    );
    expect(missingParts({ ...complete, body: limit })).toEqual([
      'The body says something is still owed: "Codex round owed: usage limit until 15:00."',
    ]);
    // Owed words in inline code, and a TODO anywhere, are a finding's subject, not owed work.
    expect(
      missingParts({
        ...complete,
        body: `${complete.body}\nA library call is marked as a TODO in its source.\n`,
      }),
    ).toEqual([]);
    expect(
      missingParts({
        ...complete,
        body: `${complete.body}\nRound 2 found a stale \`TODO\` comment. Fixed.\n`,
      }),
    ).toEqual([]);
    expect(
      missingParts({ ...complete, body: `${complete.body}\niOS screenshots still to come.\n` }),
    ).toEqual(['The body says something is still owed: "iOS screenshots still to come."']);
    expect(
      missingParts({
        ...complete,
        body: `${complete.body}\nThe Codex round is owed: usage limit.\n`,
      }),
    ).toHaveLength(1);
    // todo.md and todo/<slug> branches are not owed work.
    expect(
      missingParts({ ...complete, body: `${complete.body}\nThe item leaves todo.md (todo/x).\n` }),
    ).toEqual([]);
  });

  it('ignores the template’s comments', () => {
    const withComment = body(
      `- **x.** y\n\n<!--\n${shot('ios-after.png')}\nTODO: a dark pair\n-->`,
    );
    expect(
      missingParts({ ...complete, body: withComment, files: ['apps/ios/app/index.tsx'] }),
    ).toEqual([
      'iOS UI changed, but "What changes for the user" has no iOS screenshot (a pr-screenshots/<branch>/ios-… image) and no line "No iOS screenshot: <why>."',
    ]);
  });

  it('wants a screenshot or a reason per platform whose UI changed', () => {
    const files = ['apps/ios/src/ui/EditorHost.tsx', 'apps/desktop/renderer/calendar/Editor.tsx'];
    const userOnly = (section: string) => ({ ...complete, body: body(section), files });
    expect(
      missingParts(
        userOnly(
          `- **x.** y\n\n| iOS | Desktop |\n| --- | --- |\n| ${shot('ios-after.png')} | ${shot('desktop-after-dark.png')} |`,
        ),
      ),
    ).toEqual([]);
    expect(
      missingParts(
        userOnly(`- **x.** y\n\n${shot('ios-after.png')}\n\nNo Desktop screenshot: menu bar only.`),
      ),
    ).toEqual([]);
    expect(
      missingParts(
        userOnly(
          `- **x.** y\n\n${shot('desktop-after.png')}\n\nNo iPhone shots: no simulator runtime.`,
        ),
      ),
    ).toEqual([]);
    expect(
      missingParts(userOnly('- **x.** y\n\nNo screenshots: no screen looks different.')),
    ).toEqual([]);
    expect(missingParts(userOnly(`- **x.** y\n\n${shot('ios-after.png')}`))).toEqual([
      'Desktop UI changed, but "What changes for the user" has no Desktop screenshot (a pr-screenshots/<branch>/desktop-… image) and no line "No Desktop screenshot: <why>."',
    ]);
    // An image elsewhere in the body does not count for the user section.
    expect(
      missingParts({
        ...complete,
        body: body('- **x.** y', `\n${shot('ios-after.png')}\n`),
        files: [files[0] ?? ''],
      }),
    ).toHaveLength(1);
  });

  it('wants a decisions record citing the PR, or a reason', () => {
    expect(
      missingParts({
        ...complete,
        decisionsAdded: [['- **Other** (#3330, `todo/discard-confirm-2`)']],
      }),
    ).toEqual([
      'docs/decisions.md gains no line citing #333 or `todo/discard-confirm`; add the record, or say "No decisions entry: <why>." in the body.',
    ]);
    expect(
      missingParts({
        ...complete,
        decisionsAdded: [['- **Discard asks** (2026-11-15, `todo/discard-confirm`)']],
      }),
    ).toEqual([]);
    expect(
      missingParts({
        ...complete,
        body: `${complete.body}\nNo decisions entry: a test fix.\n`,
        decisionsAdded: [],
      }),
    ).toEqual([]);
  });

  it('wants each new decisions record ten lines at most', () => {
    expect(missingParts({ ...complete, decisionsAdded: [record(10)] })).toEqual([]);
    expect(missingParts({ ...complete, decisionsAdded: [record(11)] })).toEqual([
      'The decisions record "Closing an edited editor asks first" is 11 lines; a record is 10 at most (the mechanism goes in the doc it belongs to).',
    ]);
  });
});

describe('addedRecords', () => {
  it('counts whole new records only, run by run', () => {
    expect(
      addedRecords([
        // A new record, a blank line, then the next one.
        ['- **A** (#1) — one', '  two', '', '- **B** (#1) — one'],
        // Lines added under an existing record elsewhere in the file.
        ['  Open: something left.', '  Canvas: a link.'],
      ]),
    ).toEqual([['- **A** (#1) — one', '  two'], ['- **B** (#1) — one']]);
  });
});

describe('touchedPlatforms', () => {
  it('reads the UI folders of each app and the shared tokens, not tests', () => {
    expect(touchedPlatforms(['apps/ios/app/settings/index.tsx'])).toEqual(['iOS']);
    expect(touchedPlatforms(['apps/desktop/renderer/App.tsx', 'apps/ios/src/backend.ts'])).toEqual([
      'Desktop',
    ]);
    expect(touchedPlatforms(['brand/tokens/tokens.json'])).toEqual(['iOS', 'Desktop']);
    expect(
      touchedPlatforms(['apps/desktop/renderer/editor.test.ts', 'packages/core/src/a.ts']),
    ).toEqual([]);
  });
});
