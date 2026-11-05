import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * A `busy` flag kept by hand beside an `error` is the shape `useAction`
 * (`packages/app-state/src/action.ts`) replaces: the two are set in separate calls, so one that
 * is forgotten leaves a component running with the last run's message, or
 * failed and still busy. This keeps new ones out as far as names tell:
 * it reads the state's names, not its types, so a pair under other names
 * passes, and a state with several modes that is not an action (it wants
 * a tagged union) is nothing a pattern can check. It covers both apps and
 * the shared models from here, where Node's types are at hand.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const UI = ['apps/desktop/renderer', 'apps/ios/app', 'apps/ios/src', 'packages/app-state/src'];

// Names that only ever mean "in flight" or "what went wrong". `creating`,
// `deleting` and the like are left out: here they name an open dialog or
// its target as often as a run.
const BUSY = /^(?:busy|connecting|loading|saving|sending|submitting|working)$/;
const FAILURE = /^(?:error|failure|note|notice|problem)$/;

/** A top-level declaration: where one component or hook ends and the next begins. */
const DECLARATION =
  /^(?:export )?(?:default )?(?:async )?(?:function\*?|const|class) ([A-Za-z_$][\w$]*)/;
const STATE = /const \[(\w+),[^\]]*\] = useState\b/;

/**
 * Components and hooks found to keep the pair by hand, as `path › name`.
 * Only ever shortened: convert one, take it off.
 */
const KNOWN: ReadonlyArray<string> = [
  'apps/desktop/renderer/AccountsView.tsx › AccountsView',
  'apps/desktop/renderer/AppleCalendarSection.tsx › AppleCalendarSection',
  'apps/desktop/renderer/RemindersSection.tsx › RemindersSection',
  'apps/desktop/renderer/agents/AgentsSection.tsx › AgentsSection',
  'apps/desktop/renderer/calendar/panel/LessonPanel.tsx › ExportCard',
  'apps/desktop/renderer/onboarding/SetupDialog.tsx › GoogleStep',
  'apps/desktop/renderer/onboarding/SetupDialog.tsx › CopyStep',
  'apps/desktop/renderer/onboarding/SetupDialog.tsx › CopiedStep',
  'apps/desktop/renderer/settingsCode/ReadCodePanel.tsx › ReadCodePanel',
  'apps/ios/src/ui/settings/SettingsContext.tsx › SettingsProvider',
  'apps/ios/src/ui/settings/useSettingsTransfer.ts › useSettingsTransfer',
  'packages/app-state/src/findTimeModel.ts › useFindTimeModel',
  'packages/app-state/src/quickAddModel.ts › useQuickAddModel',
];

const sources = (): ReadonlyArray<string> =>
  UI.flatMap((dir) =>
    readdirSync(join(ROOT, dir), { encoding: 'utf8', recursive: true })
      .filter((path) => /\.tsx?$/.test(path) && !path.includes('.test.'))
      .map((path) => join(dir, path)),
  ).toSorted();

/** Every component or hook holding both a busy-like and a failure-like `useState`. */
const handKeptPairs = (): ReadonlyArray<string> =>
  sources().flatMap((path) => {
    const found: Array<string> = [];
    let name = '';
    let states: Array<string> = [];
    const close = () => {
      if (states.some((state) => BUSY.test(state)) && states.some((state) => FAILURE.test(state))) {
        found.push(`${path} › ${name}`);
      }
    };
    for (const line of readFileSync(join(ROOT, path), 'utf8').split('\n')) {
      const declared = DECLARATION.exec(line)?.[1];
      if (declared !== undefined) {
        close();
        name = declared;
        states = [];
      }
      const state = STATE.exec(line)?.[1];
      if (state !== undefined) {
        states.push(state);
      }
    }
    close();
    return found;
  });

describe('async actions in the UI', () => {
  it('go through useAction: no new busy flag kept beside an error by hand', () => {
    expect(handKeptPairs().filter((pair) => !KNOWN.includes(pair))).toEqual([]);
  });

  it('leave the known list once converted', () => {
    const pairs = handKeptPairs();
    expect(KNOWN.filter((pair) => !pairs.includes(pair))).toEqual([]);
  });
});
