import { useOnboarding, useUpdateOnboarding } from '@calendar/app-state';
import {
  cardVisible,
  type LessonId,
  type LessonRowId,
  lessonCopy,
  lessonProgress,
  lessonRows,
} from '@calendar/core';
import { useState } from 'react';
import { useOnboardingEnabled } from '../../onboarding/enabled.ts';
import { Button } from '../../ui/Button.tsx';
import { IconButton } from '../../ui/IconButton.tsx';
import { CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, MoreIcon } from '../../ui/icons.tsx';
import { Popover } from '../../ui/Popover.tsx';

/**
 * The Getting started card in the sidebar, between the mini month and
 * the calendars: one row per lesson, tried or skipped rows ticked, the
 * progress in the header. A row opens its lesson in the side panel (the
 * calendar routes it); "Add your accounts" leads the list while nothing
 * is connected and opens the setup. The chevron folds the card to one
 * line, the menu removes it; it leaves by itself once every row is
 * ticked, and never re-expands on its own — Settings › Getting Started
 * brings it back.
 */
export function GettingStartedCard({
  accountCount,
  onOpenLesson,
  onOpenSetup,
}: {
  accountCount: number;
  onOpenLesson: (id: LessonId) => void;
  onOpenSetup: () => void;
}) {
  const enabled = useOnboardingEnabled();
  const state = useOnboarding();
  const update = useUpdateOnboarding();
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number } | null>(null);
  if (!enabled || state === null || !cardVisible(state)) {
    return null;
  }
  const progress = lessonProgress(state);
  const rows = lessonRows(state, { accountCount });
  const open = (id: LessonRowId) => (id === 'accounts' ? onOpenSetup() : onOpenLesson(id));

  if (state.card === 'collapsed') {
    return (
      <button
        className="mx-2 mb-2 flex items-center gap-2 rounded-control border border-hairline bg-surface px-2.5 py-1.5 text-left text-[13px] hover:bg-fill"
        data-card-state="collapsed"
        data-testid="getting-started"
        onClick={() => void update({ card: 'expanded' })}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate font-medium">
          Getting started · {progress.done} of {progress.total}
        </span>
        <ChevronRightIcon className="shrink-0 text-ink-secondary" size={14} />
      </button>
    );
  }

  return (
    <section
      aria-label="Getting started"
      className="mx-2 mb-2 flex flex-col gap-1.5 rounded-control border border-hairline bg-surface p-2"
      data-card-state="expanded"
      data-testid="getting-started"
    >
      <div className="flex items-center gap-1 pl-1">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">Getting started</h3>
        <span className="text-[11px] text-ink-secondary" data-testid="getting-started-progress">
          {progress.done} of {progress.total}
        </span>
        <IconButton
          data-testid="getting-started-more"
          label="More"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
          size="sm"
        >
          <MoreIcon size={13} />
        </IconButton>
        <IconButton
          data-testid="getting-started-collapse"
          label="Collapse"
          onClick={() => void update({ card: 'collapsed' })}
          size="sm"
        >
          <ChevronDownIcon size={13} />
        </IconButton>
      </div>
      <div
        aria-label={`${String(progress.done)} of ${String(progress.total)} done`}
        className="mx-1 h-1 overflow-hidden rounded-full bg-fill"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${String((progress.done / progress.total) * 100)}%` }}
        />
      </div>
      <ul className="flex flex-col">
        {rows.map((row) => {
          const copy = lessonCopy(row.id, 'mac');
          const ticked = row.mark !== undefined;
          return (
            <li key={row.id}>
              <button
                className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-left hover:bg-fill"
                data-mark={row.mark}
                data-testid={`getting-started-row-${row.id}`}
                onClick={() => open(row.id)}
                type="button"
              >
                {ticked ? (
                  <CheckCircleIcon className="shrink-0 text-primary" size={15} />
                ) : (
                  <span className="size-[15px] shrink-0 rounded-full border-[1.5px] border-hairline-strong" />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-[13px] ${
                      ticked ? 'text-ink-secondary line-through' : ''
                    }`}
                  >
                    {copy.title}
                  </span>
                  {ticked ? null : (
                    <span className="block truncate text-[11px] text-ink-secondary">
                      {copy.subtitle}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <Popover
        anchor={menu}
        className="w-64"
        closeLabel="Close menu"
        label="Getting started options"
        onClose={() => setMenu(null)}
      >
        <Button
          className="w-full justify-start"
          data-testid="getting-started-hide"
          onClick={() => {
            setMenu(null);
            void update({ card: 'hidden' });
          }}
          size="sm"
          variant="ghost"
        >
          Hide the card
        </Button>
        <p className="px-2.5 pt-1 pb-1.5 text-xs text-ink-secondary">
          The lessons stay under Settings › Getting Started, which also brings the card back.
        </p>
      </Popover>
    </section>
  );
}
