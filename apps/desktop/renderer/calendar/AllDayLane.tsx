import {
  type BirthdayOccurrence,
  birthdayChipLabel,
  type EventRecord,
  MAX_ALL_DAY_ROWS,
  overdueLabel,
  type PlacedSpan,
  taskChipLabel,
  type TaskRecord,
  taskRepeats,
} from '@calendar/core';
import { useCallback, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { RepeatIcon } from '../ui/icons.tsx';
import type { ColorLookup } from './colors.ts';
import { eventLook, stripes, useTint } from './tint.ts';
import { useDropTarget, type useEventDrag } from './useEventDrag.ts';

/** One column's horizontal placement, as the strip's percentage geometry. */
const columnStyle = (startDayIndex: number, endDayIndex: number, stripLength: number) => ({
  left: `calc(${(startDayIndex / stripLength) * 100}% + 2px)`,
  width: `calc(${((endDayIndex - startDayIndex) / stripLength) * 100}% - 4px)`,
});

/**
 * A task chip in the lane: a press-and-drag moves it along the lane (day
 * change) or down into the grid (a time), a plain click opens it, the
 * checkbox completes it. While dragging along the lane the chip follows
 * the pointer column by column, like a timed block; only this chip
 * re-renders per pointermove.
 */
function AllDayTaskChip({
  drag,
  listColor,
  onTaskClick,
  onToggleTask,
  overdue,
  readOnly,
  span,
  stripLength,
  task,
  today,
}: {
  drag: ReturnType<typeof useEventDrag>;
  listColor: string | undefined;
  onTaskClick: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  overdue: boolean;
  readOnly: boolean;
  span: PlacedSpan;
  stripLength: number;
  task: TaskRecord;
  today: string;
}) {
  const mine = drag.preview?.itemKey === span.id;
  const { getDeltas, subscribeDeltas } = drag;
  const subscribe = useCallback(
    (listener: () => void) => subscribeDeltas(span.id, listener),
    [span.id, subscribeDeltas],
  );
  const snapshot = useCallback(() => (mine ? getDeltas() : null), [getDeltas, mine]);
  const deltas = useSyncExternalStore(subscribe, snapshot);
  const dragging = mine && deltas ? deltas : null;
  const done = task.status === 'completed';
  const repeats = taskRepeats(task);
  const label = taskChipLabel(task, { overdue, repeats });
  const facts = [...(overdue ? [overdueLabel(task, today)] : []), ...(repeats ? ['repeats'] : [])];
  // Follow the column the drop would land in, so the preview never lands a
  // day away from the commit; outside any target, fall back to the delta.
  const shift =
    dragging === null
      ? 0
      : dragging.target === null
        ? dragging.deltaDays
        : dragging.target.dayIndex - span.startDayIndex;
  return (
    <div
      aria-label={facts.length > 0 ? `${task.title}, ${facts.join(', ')}` : undefined}
      className={`absolute flex touch-none items-center gap-1 truncate rounded-event bg-fill px-1 text-xs leading-5 outline-none select-none focus-visible:ring-2 focus-visible:ring-focus ${
        readOnly ? 'cursor-pointer' : 'cursor-grab'
      } ${overdue ? 'text-danger' : 'text-ink-secondary'} ${done ? 'opacity-50' : ''} ${
        dragging ? 'z-20 shadow-lg' : ''
      }`}
      data-overdue={overdue ? '' : undefined}
      data-testid={`all-day-task-${task.id}`}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.stopPropagation();
          onTaskClick(task);
        }
      }}
      onPointerCancel={drag.onPointerCancel}
      onPointerDown={(event) =>
        drag.onTaskPointerDown(
          task,
          span.id,
          { dayIndex: span.startDayIndex, from: 'lane', readOnly },
          event,
        )
      }
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      role="button"
      style={{
        ...columnStyle(span.startDayIndex + shift, span.endDayIndex + shift, stripLength),
        top: span.row * 24 + 4,
      }}
      tabIndex={0}
      title={overdue ? `${task.title} · ${overdueLabel(task, today)}` : task.title}
    >
      <button
        aria-label={done ? `Reopen task ${task.title}` : `Complete task ${task.title}`}
        className="shrink-0 cursor-pointer"
        onClick={(mouse) => {
          mouse.stopPropagation();
          onToggleTask(task);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        {done ? '☑' : '☐'}
      </button>
      {/* Reminders lists have colors; a dot tells them apart from Google tasks without recoloring. */}
      {listColor ? (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: listColor }}
        />
      ) : null}
      <span className={`truncate ${done ? 'line-through' : ''}`}>{label}</span>
    </div>
  );
}

/** Highlights the lane column a timed block would drop into. */
function LaneDropIndicator({
  drag,
  stripLength,
}: {
  drag: ReturnType<typeof useEventDrag>;
  stripLength: number;
}) {
  const drop = useDropTarget(drag);
  // A chip dragged along the lane already follows the pointer.
  if (drop === null || drop.from !== 'grid' || drop.target.kind !== 'allDay') {
    return null;
  }
  return (
    <div
      className="pointer-events-none absolute inset-y-0 rounded bg-primary/10 ring-1 ring-focus ring-inset"
      data-testid="task-drop-lane"
      style={columnStyle(drop.target.dayIndex, drop.target.dayIndex + 1, stripLength)}
    />
  );
}

/**
 * Packed all-day chips (events spanning days, one-day task and birthday
 * rows) over the strip. Always rendered, even empty, so the timed grid
 * never jumps. Collapsed, `placed` is already capped and `moreByDay` says
 * which columns hide chips behind a "+N more" chip on the last row.
 */
export function AllDayLane({
  allDayById,
  birthdayById,
  collapsed,
  collapsible,
  colorOf,
  drag,
  gutterClassName,
  isTaskReadOnly,
  laneRef,
  listColorOf,
  moreByDay,
  onBirthdayClick,
  onEventClick,
  onSetCollapsed,
  onTaskClick,
  onToggleTask,
  overdueKeys,
  placed,
  rowCount,
  scrollbarWidth,
  selectedKey,
  stripLength,
  stripStyle,
  taskById,
  today,
}: {
  allDayById: ReadonlyMap<string, EventRecord>;
  birthdayById: ReadonlyMap<string, BirthdayOccurrence>;
  collapsed: boolean;
  /** Whether the uncapped lane would exceed the cap — only then is "less" offered. */
  collapsible: boolean;
  colorOf: ColorLookup;
  drag: ReturnType<typeof useEventDrag>;
  /** The hour gutter's width class, so the lane's label cell matches it. */
  gutterClassName: string;
  isTaskReadOnly: (task: TaskRecord) => boolean;
  /** The lane's root, so the drag hook can tell a release inside it. */
  laneRef: RefObject<HTMLDivElement | null>;
  listColorOf: (task: TaskRecord) => string | undefined;
  /** Hidden chips per strip column while collapsed (empty when expanded). */
  moreByDay: ReadonlyArray<number>;
  onBirthdayClick: (birthday: BirthdayOccurrence) => void;
  onEventClick: (event: EventRecord) => void;
  onSetCollapsed: (collapsed: boolean) => void;
  onTaskClick: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  /** Task keys drawn on today because their due day has passed. */
  overdueKeys: ReadonlySet<string>;
  placed: ReadonlyArray<PlacedSpan>;
  rowCount: number;
  scrollbarWidth: number;
  /** The all-day event open in the side panel, as `calendarId:id`. */
  selectedKey: string | undefined;
  stripLength: number;
  stripStyle: CSSProperties;
  taskById: ReadonlyMap<string, TaskRecord>;
  today: string;
}) {
  const tintOf = useTint();
  return (
    <div
      className="flex shrink-0 border-b border-hairline bg-surface"
      data-testid="all-day-lane"
      ref={laneRef}
      style={{ height: Math.max(rowCount, 1) * 24 + 8, paddingRight: scrollbarWidth }}
    >
      <div
        className={`shrink-0 py-1 pr-2 text-right text-[10px] text-ink-secondary ${gutterClassName}`}
      >
        all-day
        {collapsible && !collapsed ? (
          <button
            aria-label="Collapse the all-day lane"
            className="block w-full cursor-pointer text-right text-primary hover:underline"
            data-testid="all-day-less"
            onClick={() => onSetCollapsed(true)}
            type="button"
          >
            less
          </button>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="relative h-full" style={stripStyle}>
          <LaneDropIndicator drag={drag} stripLength={stripLength} />
          {moreByDay.map((hidden, dayIndex) =>
            hidden > 0 ? (
              <button
                aria-label={`${String(hidden)} more all-day items, show all`}
                className="absolute cursor-pointer truncate rounded bg-fill px-1 text-left text-xs leading-5 text-ink-secondary hover:bg-fill"
                data-testid="all-day-more"
                key={`more:${String(dayIndex)}`}
                onClick={() => onSetCollapsed(false)}
                style={{
                  left: `calc(${(dayIndex / stripLength) * 100}% + 2px)`,
                  top: (MAX_ALL_DAY_ROWS - 1) * 24 + 4,
                  width: `calc(${(1 / stripLength) * 100}% - 4px)`,
                }}
                type="button"
              >
                +{hidden} more
              </button>
            ) : null,
          )}
          {placed.map((span) => {
            const task = taskById.get(span.id);
            if (task) {
              return (
                <AllDayTaskChip
                  drag={drag}
                  key={span.id}
                  listColor={listColorOf(task)}
                  onTaskClick={onTaskClick}
                  onToggleTask={onToggleTask}
                  overdue={overdueKeys.has(span.id)}
                  readOnly={isTaskReadOnly(task)}
                  span={span}
                  stripLength={stripLength}
                  task={task}
                  today={today}
                />
              );
            }
            // Every non-task, non-birthday span is an event: the `!` below
            // relies on this branch coming first.
            const birthday = birthdayById.get(span.id);
            if (birthday) {
              const label = birthdayChipLabel(birthday);
              return (
                <div
                  // Birthdays carry no calendar color: the brand's blush says "not an event".
                  className="absolute cursor-pointer truncate rounded-event bg-event-blush px-1.5 text-xs leading-5 text-on-event-blush"
                  data-birthday={birthday.record.id}
                  key={span.id}
                  onClick={() => onBirthdayClick(birthday)}
                  style={{
                    left: `calc(${(span.startDayIndex / stripLength) * 100}% + 2px)`,
                    top: span.row * 24 + 4,
                    width: `calc(${((span.endDayIndex - span.startDayIndex) / stripLength) * 100}% - 4px)`,
                  }}
                  title={label}
                >
                  {label}
                </div>
              );
            }
            const event = allDayById.get(span.id)!;
            const color = colorOf(event);
            const tint = tintOf(color);
            const look = eventLook(event);
            const selected = selectedKey === `${event.calendarId}:${event.id}`;
            return (
              <div
                className={`absolute flex cursor-pointer items-center gap-1 truncate rounded-event px-1.5 text-xs leading-5 ${
                  selected ? 'ring-2 ring-primary' : ''
                } ${look.declined ? 'opacity-60' : ''}`}
                data-color={color}
                key={span.id}
                onClick={() => onEventClick(event)}
                style={{
                  backgroundColor: tint.fill,
                  backgroundImage: look.tentative ? stripes(tint.edge) : undefined,
                  color: tint.text,
                  left: `calc(${(span.startDayIndex / stripLength) * 100}% + 2px)`,
                  top: span.row * 24 + 4,
                  width: `calc(${((span.endDayIndex - span.startDayIndex) / stripLength) * 100}% - 4px)`,
                }}
                title={event.title}
              >
                <span className={`truncate ${look.declined ? 'line-through' : ''}`}>
                  {event.title}
                </span>
                {look.repeats ? <RepeatIcon className="shrink-0 opacity-70" size={10} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
