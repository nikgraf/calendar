import { useOnboarding, useUpdateOnboarding } from '@calendar/app-state';
import {
  DEFAULT_ONBOARDING_STATE,
  LESSON_IDS,
  lessonCopy,
  lessonProgress,
  withLessonsReset,
} from '@calendar/core';
import { SETTINGS_BUTTON_CLASS, TEXT_ACTION_CLASS } from './ui/buttonStyles.ts';
import { CheckCircleIcon } from './ui/icons.tsx';

/**
 * Settings › Getting Started: whether the card shows in the sidebar,
 * every lesson (ticked when tried or skipped) with Open — which brings
 * the calendar window forward with the lesson in its side panel — and
 * Start Over, which clears the ticks and shows the card again.
 */
export function GettingStartedSection() {
  const state = useOnboarding() ?? DEFAULT_ONBOARDING_STATE;
  const update = useUpdateOnboarding();
  const progress = lessonProgress(state);
  return (
    <>
      <section className="rounded-popover bg-surface-subtle p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            checked={state.card !== 'hidden' && progress.done < progress.total}
            data-testid="getting-started-show"
            // On with every lesson ticked: a card with nothing left would not
            // show, so it starts over.
            onChange={(change) =>
              void update(
                !change.target.checked
                  ? { card: 'hidden' }
                  : progress.done >= progress.total
                    ? withLessonsReset(state)
                    : { card: 'expanded' },
              )
            }
            type="checkbox"
          />
          Show the Getting started card in the sidebar
        </label>
        <p className="mt-1 ml-6 text-xs text-ink-secondary">
          It leaves by itself when every lesson is done; unticking hides it now. The lessons stay
          here either way.
        </p>
      </section>
      <section
        className="rounded-popover bg-surface-subtle p-4"
        data-testid="getting-started-lessons"
      >
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Lessons</h2>
          <span className="text-xs text-ink-secondary" data-testid="getting-started-count">
            {progress.done} of {progress.total} done
          </span>
        </div>
        <ul className="mt-2 flex flex-col divide-y divide-hairline">
          {LESSON_IDS.map((id) => {
            const copy = lessonCopy(id, 'mac');
            const ticked = state.lessons[id] !== undefined;
            return (
              <li
                className="flex items-center gap-3 py-2"
                data-mark={state.lessons[id]}
                data-testid={`getting-started-lesson-${id}`}
                key={id}
              >
                {ticked ? (
                  <CheckCircleIcon className="shrink-0 text-primary" size={16} />
                ) : (
                  <span className="size-4 shrink-0 rounded-full border-[1.5px] border-hairline-strong" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{copy.title}</span>
                  <span className="block text-xs text-ink-secondary">{copy.subtitle}</span>
                </span>
                <button
                  className={`text-sm ${TEXT_ACTION_CLASS.primary}`}
                  data-testid={`getting-started-open-${id}`}
                  onClick={() => void window.calendarBridge.openLesson(id)}
                  type="button"
                >
                  Open
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-ink-secondary">
          A tick means you tried or skipped it. Open any lesson again, any time.
        </p>
      </section>
      <section className="rounded-popover bg-surface-subtle p-4">
        <h2 className="font-medium">Start over</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Clears the ticks and shows the card again. Nothing else changes.
        </p>
        <button
          className={`${SETTINGS_BUTTON_CLASS} mt-3`}
          data-testid="getting-started-start-over"
          onClick={() => void update(withLessonsReset(state))}
          type="button"
        >
          Start Over
        </button>
      </section>
    </>
  );
}
