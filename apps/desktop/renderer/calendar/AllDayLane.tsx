import {
  type BirthdayOccurrence,
  birthdayChipLabel,
  calendarTaskKey,
  type EventRecord,
  MAX_ALL_DAY_ROWS,
  overdueLabel,
  type PlacedSpan,
  taskChipLabel,
  type TaskBacklogEntry,
  type TaskFold,
  taskFoldDescription,
  taskFoldLabel,
  type TaskRecord,
  taskRepeats,
} from '@calendar/core';
import type { DraftOccurrence } from '@calendar/app-state';
import {
  useCallback,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from 'react';
import { ChevronDownIcon, ChevronUpIcon, ListIcon, RepeatIcon } from '../ui/icons.tsx';
import type { ColorLookup } from './colors.ts';
import { DraftChip } from './DraftBlock.tsx';
import { TaskCheck } from './TaskCheck.tsx';
import { FOLD_POPOVER_WIDTH, TaskFoldPopover } from './TaskFoldPopover.tsx';
import { eventLook, stripes, useTint } from './tint.ts';
import { useDropTarget, type useEventDrag } from './useEventDrag.ts';

/** One lane row: a 20 px chip and the 4 px gap under it. */
export const LANE_ROW_PX = 24;
/** How much of the first chip below the fold a scrolling lane shows: half of it, so the cut reads as "more". */
const PEEK_PX = 10;

/** A fold's chip in the lane. */
export type FoldEntry = Extract<TaskBacklogEntry, { kind: 'fold' }>;

/** The open fold list: the rows its chip held when it opened, and where it hangs. */
interface OpenFold {
  readonly anchor: { readonly x: number; readonly y: number };
  /** Takes the focus back when the list is dismissed. */
  readonly chip: HTMLElement;
  readonly fold: TaskFold;
  readonly keys: ReadonlyArray<string>;
}

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
      className={`absolute flex touch-none items-center gap-0.5 truncate rounded-event bg-fill pr-1.5 text-xs leading-5 outline-none select-none focus-visible:ring-2 focus-visible:ring-focus ${
        readOnly ? 'cursor-pointer' : 'cursor-grab'
      } ${overdue ? 'text-danger' : 'text-ink'} ${dragging ? 'z-20 shadow-lg' : ''}`}
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
        top: span.row * LANE_ROW_PX + 4,
      }}
      tabIndex={0}
      title={overdue ? `${task.title} · ${overdueLabel(task, today)}` : task.title}
    >
      {/* Reminders lists have colors; the box takes it, which tells them apart from Google tasks. */}
      <TaskCheck
        aria-label={done ? `Reopen task ${task.title}` : `Complete task ${task.title}`}
        checked={done}
        listColor={listColor}
        onClick={(mouse) => {
          mouse.stopPropagation();
          onToggleTask(task);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        overdue={overdue}
      />
      <span className={`truncate ${done ? 'text-ink-secondary line-through' : ''}`}>{label}</span>
    </div>
  );
}

/**
 * Today's overdue or undated backlog folded into one chip (`foldTaskBacklog`):
 * the count leads, so a narrow column still shows it; a click opens the list.
 */
function FoldChip({
  entry,
  onOpen,
  open,
  span,
  stripLength,
}: {
  entry: FoldEntry;
  onOpen: (entry: FoldEntry, chip: HTMLElement) => void;
  open: boolean;
  span: PlacedSpan;
  stripLength: number;
}) {
  const count = entry.tasks.length;
  return (
    <button
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`${taskFoldDescription(entry.fold, count)}, show the list`}
      className={`absolute flex cursor-pointer items-center gap-1 rounded-event bg-fill px-1.5 text-left text-xs leading-5 font-medium outline-none hover:ring-1 hover:ring-hairline-strong focus-visible:ring-2 focus-visible:ring-focus ${
        entry.fold === 'overdue' ? 'text-danger' : 'text-ink'
      }`}
      data-testid={`all-day-fold-${entry.fold}`}
      onClick={(event) => onOpen(entry, event.currentTarget)}
      style={{
        ...columnStyle(span.startDayIndex, span.endDayIndex, stripLength),
        top: span.row * LANE_ROW_PX + 4,
      }}
      type="button"
    >
      {/* The overdue label carries its own warning marker. */}
      {entry.fold === 'undated' ? <ListIcon className="shrink-0" size={12} /> : null}
      <span className="truncate">{taskFoldLabel(entry.fold, count)}</span>
    </button>
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
  if (drop === null || drop.from === 'lane' || drop.target.kind !== 'allDay') {
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
 * rows, today's folded backlog) over the strip. Always rendered, even
 * empty, so the timed grid never jumps. Collapsed, `placed` is already
 * capped and `moreByDay` says which columns hide chips behind a "+N more"
 * chip on the last row. Expanded, the lane grows to `maxRows` and then
 * scrolls inside itself, stopping halfway into the next chip, so the
 * timed grid always keeps most of the view. The chevron under "all-day"
 * switches between the two whenever the lane has more than the collapsed
 * rows.
 */
export function AllDayLane({
  allDayById,
  birthdayById,
  collapsed,
  collapsible,
  colorOf,
  draftById,
  drag,
  foldById,
  gutterClassName,
  isTaskReadOnly,
  laneRef,
  listColorOf,
  maxRows,
  moreByDay,
  onBirthdayClick,
  onDraftClick,
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
  /** Whether the uncapped lane would exceed the collapsed rows — only then is the chevron offered. */
  collapsible: boolean;
  colorOf: ColorLookup;
  /** The editor's all-day drafts in the lane, by span id. */
  draftById: ReadonlyMap<string, DraftOccurrence>;
  drag: ReturnType<typeof useEventDrag>;
  /** Today's folded backlog, by span id (`taskFoldKey`). */
  foldById: ReadonlyMap<string, FoldEntry>;
  /** The hour gutter's width class, so the lane's label cell matches it. */
  gutterClassName: string;
  isTaskReadOnly: (task: TaskRecord) => boolean;
  /** The lane's root, so the drag hook can tell a release inside it. */
  laneRef: RefObject<HTMLDivElement | null>;
  listColorOf: (task: TaskRecord) => string | undefined;
  /** Rows the expanded lane shows before it scrolls (`expandedAllDayRows`). */
  maxRows: number;
  /** Hidden chips per strip column while collapsed (empty when expanded). */
  moreByDay: ReadonlyArray<number>;
  onBirthdayClick: (birthday: BirthdayOccurrence) => void;
  onDraftClick: (draftId: string) => void;
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
  /** Every task the lane may show, by `calendarTaskKey` — a fold's list reads its rows here. */
  taskById: ReadonlyMap<string, TaskRecord>;
  today: string;
}) {
  const tintOf = useTint();
  const [openFold, setOpenFold] = useState<OpenFold | null>(null);
  const contentHeight = Math.max(rowCount, 1) * LANE_ROW_PX + 8;
  // Collapsed, `rowCount` is at most MAX_ALL_DAY_ROWS, never past `maxRows`.
  const scrolls = rowCount > maxRows;
  const showFold = (entry: FoldEntry, chip: HTMLElement) => {
    const box = chip.getBoundingClientRect();
    setOpenFold({
      anchor: {
        x: Math.max(Math.min(box.left, window.innerWidth - FOLD_POPOVER_WIDTH - 8), 8),
        y: box.bottom + 4,
      },
      chip,
      fold: entry.fold,
      keys: entry.tasks.map(calendarTaskKey),
    });
  };
  return (
    <div
      className="flex shrink-0 border-b border-hairline bg-surface"
      data-scrolls={scrolls ? '' : undefined}
      data-testid="all-day-lane"
      ref={laneRef}
      style={{
        height: scrolls ? maxRows * LANE_ROW_PX + 4 + PEEK_PX : contentHeight,
        paddingRight: scrollbarWidth,
      }}
    >
      <div
        className={`flex shrink-0 flex-col items-end gap-1 py-1 pr-2 text-[10px] text-ink-secondary ${gutterClassName}`}
      >
        all-day
        {collapsible ? (
          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Show all all-day items' : 'Show fewer all-day items'}
            className="flex size-5 cursor-pointer items-center justify-center rounded-control border border-hairline text-ink-secondary hover:bg-fill hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            data-testid="all-day-toggle"
            onClick={() => onSetCollapsed(!collapsed)}
            title={collapsed ? 'Show all' : 'Show fewer'}
            type="button"
          >
            {collapsed ? <ChevronDownIcon size={14} /> : <ChevronUpIcon size={14} />}
          </button>
        ) : null}
      </div>
      {/* Scrolls up and down; the box inside clips the panning strip, so
          nothing ever scrolls it sideways (a focused chip, scrollIntoView). */}
      <div
        className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-width:none]"
        data-testid="all-day-scroller"
      >
        <div className="relative overflow-hidden" style={{ height: contentHeight }}>
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
                    top: (MAX_ALL_DAY_ROWS - 1) * LANE_ROW_PX + 4,
                    width: `calc(${(1 / stripLength) * 100}% - 4px)`,
                  }}
                  type="button"
                >
                  +{hidden} more
                </button>
              ) : null,
            )}
            {placed.map((span) => {
              const fold = foldById.get(span.id);
              if (fold) {
                return (
                  <FoldChip
                    entry={fold}
                    key={span.id}
                    onOpen={showFold}
                    open={openFold?.fold === fold.fold}
                    span={span}
                    stripLength={stripLength}
                  />
                );
              }
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
              const draft = draftById.get(span.id);
              if (draft) {
                return (
                  <DraftChip
                    key={span.id}
                    occurrence={draft}
                    onClick={onDraftClick}
                    style={{
                      left: `calc(${(span.startDayIndex / stripLength) * 100}% + 2px)`,
                      top: span.row * LANE_ROW_PX + 4,
                      width: `calc(${((span.endDayIndex - span.startDayIndex) / stripLength) * 100}% - 4px)`,
                    }}
                  />
                );
              }
              // Every non-task, non-birthday, non-draft span is an event: the
              // `!` below relies on these branches coming first.
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
                      top: span.row * LANE_ROW_PX + 4,
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
                    top: span.row * LANE_ROW_PX + 4,
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
      {openFold ? (
        <TaskFoldPopover
          anchor={openFold.anchor}
          drag={drag}
          fold={openFold.fold}
          isTaskReadOnly={isTaskReadOnly}
          listColorOf={listColorOf}
          onClose={() => setOpenFold(null)}
          onDismiss={() => {
            setOpenFold(null);
            // Back to the chip, unless it is gone (the group shrank to one).
            if (openFold.chip.isConnected) {
              openFold.chip.focus();
            }
          }}
          onTaskClick={onTaskClick}
          onToggleTask={onToggleTask}
          tasks={openFold.keys.flatMap((key) => taskById.get(key) ?? [])}
          today={today}
        />
      ) : null}
    </div>
  );
}
