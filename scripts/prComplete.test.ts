import { describe, expect, it } from 'vite-plus/test';
import { addedRecords, missingParts, type PullRequest, touchedPlatforms } from './prComplete.ts';

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

  it('fails a body that says something is still owed', () => {
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
