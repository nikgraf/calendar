import { type EventRecord, type PlacedSpan, taskChipLabel, type TaskRecord } from '@calendar/core';
import type { CSSProperties } from 'react';
import { chipTextColor, type ColorLookup } from './colors.ts';

/**
 * Packed all-day chips (events spanning days, one-day task rows) over the
 * strip. Always rendered, even empty, so the timed grid never jumps.
 */
export function AllDayLane({
  allDayById,
  colorOf,
  listColorOf,
  onEventClick,
  onTaskClick,
  onToggleTask,
  placed,
  rowCount,
  scrollbarWidth,
  stripLength,
  stripStyle,
  taskById,
}: {
  allDayById: ReadonlyMap<string, EventRecord>;
  colorOf: ColorLookup;
  listColorOf: (task: TaskRecord) => string | undefined;
  onEventClick: (event: EventRecord) => void;
  onTaskClick: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  placed: ReadonlyArray<PlacedSpan>;
  rowCount: number;
  scrollbarWidth: number;
  stripLength: number;
  stripStyle: CSSProperties;
  taskById: ReadonlyMap<string, TaskRecord>;
}) {
  return (
    <div
      className="flex shrink-0 border-b border-neutral-200 bg-white"
      style={{ height: Math.max(rowCount, 1) * 24 + 8, paddingRight: scrollbarWidth }}
    >
      <div className="w-16 shrink-0 py-1 pr-2 text-right text-[10px] text-neutral-400">all-day</div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="relative h-full" style={stripStyle}>
          {placed.map((span) => {
            const task = taskById.get(span.id);
            if (task) {
              const done = task.status === 'completed';
              return (
                <div
                  className={`absolute flex cursor-pointer items-center gap-1 truncate rounded border border-neutral-300 bg-neutral-50 px-1 text-xs leading-5 text-neutral-700 ${done ? 'opacity-50' : ''}`}
                  key={span.id}
                  onClick={() => onTaskClick(task)}
                  style={{
                    // Reminders lists have colors; a left accent tells
                    // them apart from Google tasks without recoloring.
                    ...(listColorOf(task)
                      ? { borderLeftColor: listColorOf(task), borderLeftWidth: 3 }
                      : {}),
                    left: `calc(${(span.startDayIndex / stripLength) * 100}% + 2px)`,
                    top: span.row * 24 + 4,
                    width: `calc(${((span.endDayIndex - span.startDayIndex) / stripLength) * 100}% - 4px)`,
                  }}
                  title={task.title}
                >
                  <button
                    aria-label={done ? `Reopen task ${task.title}` : `Complete task ${task.title}`}
                    className="shrink-0 cursor-pointer"
                    onClick={(mouse) => {
                      mouse.stopPropagation();
                      onToggleTask(task);
                    }}
                    type="button"
                  >
                    {done ? '☑' : '☐'}
                  </button>
                  <span className={`truncate ${done ? 'line-through' : ''}`}>
                    {taskChipLabel(task)}
                  </span>
                </div>
              );
            }
            const event = allDayById.get(span.id)!;
            const color = colorOf(event);
            return (
              <div
                className="absolute cursor-pointer truncate rounded px-1.5 text-xs leading-5"
                key={span.id}
                onClick={() => onEventClick(event)}
                style={{
                  backgroundColor: color,
                  color: chipTextColor(color),
                  left: `calc(${(span.startDayIndex / stripLength) * 100}% + 2px)`,
                  top: span.row * 24 + 4,
                  width: `calc(${((span.endDayIndex - span.startDayIndex) / stripLength) * 100}% - 4px)`,
                }}
                title={event.title}
              >
                {event.title}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
