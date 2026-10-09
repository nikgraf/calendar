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
import { TaskCheck } from './TaskCheck.tsx';
import type { useEventDrag } from './useEventDrag.ts';

/** A point-in-time Apple Reminder rendered as a compact, move-only block. */
export function TimedTaskBlock({
  box,
  dayIndex,
  drag,
  hourHeight,
  listColor,
  onTaskClick,
  onToggleTask,
  readOnly,
  task,
}: {
  box: PositionedBox;
  /** The strip column this block sits in; a drag's drop day is counted from it. */
  dayIndex: number;
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
      className={`absolute flex h-[22px] touch-none items-center gap-0.5 overflow-hidden rounded-event bg-fill pr-1.5 pl-px text-xs text-ink outline-none select-none focus-visible:ring-2 focus-visible:ring-focus ${
        readOnly ? 'cursor-pointer' : 'cursor-grab'
      } ${dragging ? 'z-20 shadow-lg' : ''}`}
      data-testid={`timed-task-${task.id}`}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.stopPropagation();
          onTaskClick(task);
        }
      }}
      onPointerCancel={drag.onPointerCancel}
      onPointerDown={(event) =>
        drag.onTaskPointerDown(task, key, { dayIndex, from: 'grid', readOnly }, event)
      }
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      role="button"
      style={{
        left: `calc(${(box.left + (dragging?.deltaDays ?? 0)) * 100}% + 1px)`,
        top: `calc(${box.top * 100}% + ${((dragging?.deltaMinutes ?? 0) / 60) * hourHeight}px)`,
        width: `calc(${box.width * 100}% - 3px)`,
      }}
      tabIndex={0}
      title={`${task.title} · ${dueLabel}`}
    >
      <TaskCheck
        aria-label={done ? `Reopen reminder ${task.title}` : `Complete reminder ${task.title}`}
        checked={done}
        listColor={listColor}
        onClick={(event) => {
          event.stopPropagation();
          onToggleTask(task);
        }}
        onPointerDown={(event) => event.stopPropagation()}
      />
      <span className={`truncate ${done ? 'text-ink-secondary line-through' : ''}`}>{label}</span>
      {repeats ? (
        <span aria-hidden className="shrink-0 text-ink-secondary">
          {REPEAT_MARKER}
        </span>
      ) : null}
    </div>
  );
}
