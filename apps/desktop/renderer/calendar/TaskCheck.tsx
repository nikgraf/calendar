import { contrastingTextColor } from '@calendar/core';
import type { ComponentProps, CSSProperties } from 'react';

/**
 * Box diameter, the button's hit square and the tick's stroke (in the
 * 16-unit viewBox) per place: the week grid's chips and timed blocks, the
 * month cells' shorter chips, and the rail's rows and the editors.
 */
const SIZES = {
  chip: { box: 14, hit: 'size-5', tick: 2.3 },
  month: { box: 12, hit: 'size-4', tick: 2.4 },
  row: { box: 18, hit: 'size-7', tick: 2.1 },
} as const;

export type TaskCheckSize = keyof typeof SIZES;

/**
 * The task checkbox's look: a ring that fills and draws a tick when done.
 * A Reminders list's color stands in for the neutral ring and the primary
 * fill (so a chip needs no separate list dot), and an open overdue task
 * rings in the danger color. Hover, press and the tick live in App.css
 * under `.task-check`; `data-done` is its state and the e2e handle.
 */
export function TaskCheckMark({
  checked,
  listColor,
  overdue = false,
  size,
}: {
  checked: boolean;
  listColor?: string | undefined;
  overdue?: boolean;
  size: TaskCheckSize;
}) {
  const { box, tick } = SIZES[size];
  const vars: Record<string, string> = {
    '--task-check-size': `${box}px`,
    '--task-check-tick-width': String(tick),
  };
  if (listColor) {
    vars['--task-check-fill'] = listColor;
    vars['--task-check-hover'] = listColor;
    vars['--task-check-ring'] = listColor;
    vars['--task-check-tick'] = contrastingTextColor(listColor);
  }
  if (overdue && !checked) {
    vars['--task-check-hover'] = 'var(--danger)';
    vars['--task-check-ring'] = 'var(--danger)';
  }
  return (
    <span
      aria-hidden
      className="task-check"
      data-done={checked ? '' : undefined}
      style={vars as CSSProperties}
    >
      <svg viewBox="0 0 16 16">
        <path d="M4.6 8.3 7 10.7 11.5 5.6" />
      </svg>
    </span>
  );
}

/** A task's checkbox button: the mark centered in a hit square the height of its row. */
export function TaskCheck({
  checked,
  className = '',
  listColor,
  overdue = false,
  size = 'chip',
  ...button
}: Omit<ComponentProps<'button'>, 'children' | 'type'> & {
  checked: boolean;
  listColor?: string | undefined;
  overdue?: boolean;
  size?: TaskCheckSize;
}) {
  return (
    <button
      className={`flex shrink-0 cursor-pointer items-center justify-center outline-none disabled:cursor-default disabled:opacity-50 ${SIZES[size].hit} ${className}`}
      type="button"
      {...button}
    >
      <TaskCheckMark checked={checked} listColor={listColor} overdue={overdue} size={size} />
    </button>
  );
}
