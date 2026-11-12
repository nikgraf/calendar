import type { useThreadEditor } from '@calendar/app-state';
import { Button } from '../../ui/Button.tsx';
import { IconButton } from '../../ui/IconButton.tsx';
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons.tsx';

/**
 * The pager over several drafts, under the editor's header in either
 * view, left out while there is one draft: the previous and next draft
 * around the focused one's place among them, then Remove and "Add all";
 * under them, why "Add all" stopped. Off while an older step is on show.
 */
export function DraftPager({
  confirming,
  editor,
}: {
  /** A question above the footer waits for its answer: "Add all" waits too. */
  readonly confirming: boolean;
  readonly editor: ReturnType<typeof useThreadEditor>;
}) {
  const {
    addAll,
    batchError,
    canAddAll,
    drafts,
    draftsSettled,
    focused,
    switchFocus,
    thread,
    write,
  } = editor;
  if (drafts.length < 2 && !batchError) {
    return null;
  }
  return (
    <div className="flex shrink-0 flex-col gap-2 px-4 pb-2">
      {drafts.length > 1 ? (
        <div className="flex items-center justify-between" data-testid="draft-pager">
          <div className="flex items-center gap-1">
            <IconButton
              data-testid="draft-prev"
              disabled={focused === 0 || !draftsSettled}
              label="Previous draft"
              onClick={() => switchFocus(focused - 1)}
              size="sm"
            >
              <ChevronLeftIcon size={14} />
            </IconButton>
            <span className="text-xs text-ink-secondary" data-testid="draft-position">
              {focused + 1} of {drafts.length}
            </span>
            <IconButton
              data-testid="draft-next"
              disabled={focused >= drafts.length - 1 || !draftsSettled}
              label="Next draft"
              onClick={() => switchFocus(focused + 1)}
              size="sm"
            >
              <ChevronRightIcon size={14} />
            </IconButton>
          </div>
          <div className="flex items-center gap-1">
            <Button
              data-testid="draft-remove"
              disabled={!draftsSettled}
              onClick={() => thread.remove(focused)}
              size="sm"
              variant="ghost"
            >
              Remove
            </Button>
            {canAddAll ? (
              <Button
                aria-busy={write.busy}
                data-testid="draft-add-all"
                disabled={confirming || !draftsSettled}
                onClick={() => void addAll()}
                size="sm"
                variant="primary"
              >
                Add all {drafts.length}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {batchError ? (
        <p
          className="select-text rounded-control bg-fill p-2 text-sm text-danger"
          data-testid="draft-batch-error"
        >
          {batchError}
        </p>
      ) : null}
    </div>
  );
}
