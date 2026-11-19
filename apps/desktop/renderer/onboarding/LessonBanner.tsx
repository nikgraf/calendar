import { LESSON_COUNT, type LessonId, lessonCopy, lessonPosition } from '@calendar/core';
import { Button } from '../ui/Button.tsx';
import { SparkleIcon } from '../ui/icons.tsx';

/** What the banner says to do, per lesson that runs inside an existing surface. */
const HINTS: Partial<Record<LessonId, string>> = {
  create:
    'Press Return to send it, or say it — the draft lands on the grid, dashed until you save.',
  search: 'The sentence became the chips: remove one, or say more — “only tasks”, “in Vienna”.',
};

/**
 * The lesson's frame when the lesson is an existing surface: a line
 * above the editor's conversation or the search field saying which
 * lesson this is and what to try, with Skip until it was tried. The
 * surface itself is the real thing; nothing else changes.
 */
export function LessonBanner({
  action,
  id,
  note,
  onSkip,
  progress,
}: {
  /** What the note asks for (the Create lesson's download of the Assistant's model). */
  action?: { readonly label: string; readonly onClick: () => void } | undefined;
  id: LessonId;
  /** In place of the hint: the Create lesson without the Assistant's model, and the demo standing in. */
  note?: string | undefined;
  /** Absent once the lesson was tried: the hint stays, Skip has nothing left to skip. */
  onSkip?: (() => void) | undefined;
  /** How far the model's download is, in percent, while it runs. */
  progress?: number | undefined;
}) {
  const copy = lessonCopy(id, 'mac');
  return (
    <div
      className="mb-3 flex items-start gap-2.5 rounded-control bg-fill px-3 py-2"
      data-lesson={id}
      data-testid="lesson-banner"
    >
      <SparkleIcon className="mt-0.5 shrink-0 text-primary" size={14} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">
          Getting started · {lessonPosition(id)} of {LESSON_COUNT} — {copy.title}
        </p>
        <p className="mt-0.5 text-xs text-ink-secondary" data-testid="lesson-banner-note">
          {note ?? HINTS[id] ?? copy.intro}
        </p>
        {progress === undefined ? null : (
          <div
            aria-label={`${String(progress)} percent downloaded`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress}
            className="mt-2 h-1 w-full overflow-hidden rounded-full bg-hairline-strong"
            data-testid="lesson-model-progress"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${String(progress)}%` }}
            />
          </div>
        )}
        {action === undefined ? null : (
          <Button
            className="mt-2"
            data-testid="lesson-model-action"
            onClick={action.onClick}
            size="sm"
            variant="primary"
          >
            {action.label}
          </Button>
        )}
      </div>
      {onSkip ? (
        <Button data-testid="lesson-skip" onClick={onSkip} size="sm" variant="ghost">
          Skip
        </Button>
      ) : null}
    </div>
  );
}
