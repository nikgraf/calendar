import { LESSON_COUNT, type LessonId, lessonCopy, lessonPosition } from '@calendar/core';
import { Button } from '../ui/Button.tsx';
import { SparkleIcon } from '../ui/icons.tsx';

/** What the banner says to do, per lesson that runs inside an existing surface. */
const HINTS: Partial<Record<LessonId, string>> = {
  create: 'Type or say it, then Apply — the draft lands on the grid, dashed until you save.',
  search: 'The sentence became the chips: remove one, or say more — “only tasks”, “in Vienna”.',
};

/**
 * The lesson's frame when the lesson is an existing surface: a line
 * above the editor's quick-add field or the search field saying which
 * lesson this is and what to try, with Skip until it was tried. The
 * surface itself is the real thing; nothing else changes.
 */
export function LessonBanner({
  id,
  note,
  onSkip,
}: {
  id: LessonId;
  /** In place of the hint: why the lesson cannot run as drawn (the model is not ready). */
  note?: string | undefined;
  /** Absent once the lesson was tried: the hint stays, Skip has nothing left to skip. */
  onSkip?: (() => void) | undefined;
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
        <p className="mt-0.5 text-xs text-ink-secondary">{note ?? HINTS[id] ?? copy.intro}</p>
      </div>
      {onSkip ? (
        <Button data-testid="lesson-skip" onClick={onSkip} size="sm" variant="ghost">
          Skip
        </Button>
      ) : null}
    </div>
  );
}
