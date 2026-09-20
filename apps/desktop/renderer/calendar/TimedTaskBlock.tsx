import {
  calendarTaskKey,
  formatPlainTime,
  type PositionedBox,
  priorityMarker,
  REPEAT_MARKER,
  type TaskRecord,
  taskRepeats,
} from '@calendar/core';
import { useCallback, useSyncExternalStore } from 'react';
import type { useEventDrag } from './useEventDrag.ts';

/** A point-in-time Apple Reminder rendered as a compact, move-only block. */
export function TimedTaskBlock({
  box,
  drag,
  hourHeight,
  listColor,
  onTaskClick,
  onToggleTask,
  readOnly,
  task,
}: {
  box: PositionedBox;
  drag: ReturnType<typeof useEventDrag>;
  hourHeight: number;
  listColor: string | undefined;
  onTaskClick: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  readOnly: boolean;
  task: TaskRecord;
}) {
  const key = calendarTaskKey(task);
  const mine = drag.preview?.itemKey === key;
  const { getDeltas, subscribeDeltas } = drag;
  const subscribe = useCallback(
    (listener: () => void) => subscribeDeltas(key, listener),
    [key, subscribeDeltas],
  );
  const snapshot = useCallback(() => (mine ? getDeltas() : null), [getDeltas, mine]);
  const deltas = useSyncExternalStore(subscribe, snapshot);
  const dragging = mine && deltas ? deltas : null;
  const done = task.status === 'completed';
  const marker = priorityMarker(task.priority);
  const label = `${marker ? `${marker} ` : ''}${task.title}`;
  const repeats = taskRepeats(task);
  const dueLabel = formatPlainTime(task.dueTime!);

  return (
    <div
      aria-label={`${task.title}, due ${dueLabel}${repeats ? ', repeats' : ''}`}
      className={`absolute flex h-[22px] touch-none items-center gap-1 overflow-hidden rounded border border-neutral-300 bg-neutral-50 px-1 text-xs text-neutral-700 outline-none select-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        readOnly ? 'cursor-pointer' : 'cursor-grab'
      } ${done ? 'opacity-50' : ''} ${dragging ? 'z-20 shadow-lg ring-2 ring-white/60' : ''}`}
      data-testid={`timed-task-${task.id}`}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.stopPropagation();
          onTaskClick(task);
        }
      }}
      onPointerCancel={drag.onPointerCancel}
      onPointerDown={(event) => drag.onTaskPointerDown(task, key, readOnly, event)}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      role="button"
      style={{
        ...(listColor ? { borderLeftColor: listColor, borderLeftWidth: 3 } : {}),
        left: `calc(${(box.left + (dragging?.deltaDays ?? 0)) * 100}% + 1px)`,
        top: `calc(${box.top * 100}% + ${((dragging?.deltaMinutes ?? 0) / 60) * hourHeight}px)`,
        width: `calc(${box.width * 100}% - 3px)`,
      }}
      tabIndex={0}
      title={`${task.title} · ${dueLabel}`}
    >
      <button
        aria-label={done ? `Reopen reminder ${task.title}` : `Complete reminder ${task.title}`}
        className="shrink-0 cursor-pointer"
        onClick={(event) => {
          event.stopPropagation();
          onToggleTask(task);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        {done ? '☑' : '☐'}
      </button>
      <span className={`truncate ${done ? 'line-through' : ''}`}>{label}</span>
      {repeats ? (
        <span aria-hidden className="shrink-0 text-neutral-500">
          {REPEAT_MARKER}
        </span>
      ) : null}
    </div>
  );
}
