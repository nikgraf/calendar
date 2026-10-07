import {
  type EventRecord,
  formatClockTime,
  formatZoneRange,
  type PositionedBox,
} from '@calendar/core';
import { useCallback, useSyncExternalStore } from 'react';
import { chipTextColor } from './colors.ts';
import type { useEventDrag } from './useEventDrag.ts';

const MINUTE_MS = 60 * 1000;

/**
 * A timed event in a day column, with its live drag/resize preview. Only
 * the block being dragged subscribes to the pointer offsets (the snapshot
 * for every other block is a stable null), so a pointermove re-renders one
 * block, not the grid.
 */
export function TimedEventBlock({
  box,
  color,
  drag,
  event,
  hourHeight,
  onEventClick,
  readOnly,
  secondaryZones,
  timeZone,
}: {
  box: PositionedBox;
  color: string;
  drag: ReturnType<typeof useEventDrag>;
  event: EventRecord;
  hourHeight: number;
  onEventClick: (event: EventRecord) => void;
  /** In a calendar we cannot write: opens on click, offers no move or resize. */
  readOnly: boolean;
  /** The non-primary zones; a tall block adds their start–end as a third line. */
  secondaryZones: ReadonlyArray<string>;
  timeZone: string;
}) {
  const mine = drag.preview?.itemKey === box.id;
  const { getDeltas, subscribeDeltas } = drag;
  const subscribe = useCallback(
    (listener: () => void) => subscribeDeltas(box.id, listener),
    [box.id, subscribeDeltas],
  );
  const snapshot = useCallback(() => (mine ? getDeltas() : null), [getDeltas, mine]);
  const deltas = useSyncExternalStore(subscribe, snapshot);
  const dragging = mine && deltas ? { ...drag.preview!, ...deltas } : null;
  const moveMinutes = dragging?.mode === 'move' ? dragging.deltaMinutes : 0;
  const resizeMinutes = dragging?.mode === 'resize' ? dragging.deltaMinutes : 0;
  const deltaDays = dragging?.mode === 'move' ? dragging.deltaDays : 0;
  const dayMinutes = 24 * 60;
  const topMinutes = box.top * dayMinutes + moveMinutes;
  const heightMinutes = Math.max(box.height * dayMinutes + resizeMinutes, 15);
  const previewStart = event.startUtc + moveMinutes * MINUTE_MS;
  const previewEnd =
    dragging?.mode === 'resize'
      ? Math.max(event.endUtc + resizeMinutes * MINUTE_MS, event.startUtc + 15 * MINUTE_MS)
      : event.endUtc + moveMinutes * MINUTE_MS;
  const pixelHeight = (heightMinutes / 60) * hourHeight;
  const compact = pixelHeight < 28;
  // Three lines need ~46px; the primary line alone hides below 28.
  const showZones = secondaryZones.length > 0 && pixelHeight >= 46;
  const draggable = !event.recurrence && !readOnly;
  return (
    <div
      aria-label={`${event.title}, ${formatClockTime(event.startUtc, timeZone)} to ${formatClockTime(event.endUtc, timeZone)}`}
      className={`absolute touch-none overflow-hidden rounded-md px-1.5 py-0.5 outline-none select-none focus-visible:ring-2 focus-visible:ring-focus ${
        draggable ? 'cursor-grab' : 'cursor-pointer'
      } ${dragging ? 'z-20 opacity-90 shadow-lg ring-2 ring-white/60' : ''}`}
      key={box.id}
      onKeyDown={(keyEvent) => {
        if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          onEventClick(event);
        }
      }}
      onPointerCancel={drag.onPointerCancel}
      onPointerDown={(pointerEvent) => drag.onPointerDown(event, box.id, pointerEvent, 'move')}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      role="button"
      style={{
        backgroundColor: color,
        color: chipTextColor(color),
        height: `max(${(heightMinutes / dayMinutes) * 100}%, 14px)`,
        left: `calc(${(box.left + deltaDays) * 100}% + 1px)`,
        top: `${(topMinutes / dayMinutes) * 100}%`,
        width: `calc(${box.width * 100}% - 3px)`,
      }}
      tabIndex={0}
      title={`${event.title} · ${formatClockTime(event.startUtc, timeZone)}`}
    >
      <p className="truncate text-xs leading-4 font-medium">{event.title}</p>
      {compact ? null : (
        <p className="truncate text-[10px] opacity-80">
          {formatClockTime(dragging ? previewStart : event.startUtc, timeZone)} –{' '}
          {formatClockTime(dragging ? previewEnd : event.endUtc, timeZone)}
        </p>
      )}
      {showZones ? (
        <p className="truncate text-[9px] opacity-60" data-testid="event-secondary-times">
          {formatZoneRange(
            dragging ? previewStart : event.startUtc,
            dragging ? previewEnd : event.endUtc,
            secondaryZones,
          )}
        </p>
      ) : null}
      {draggable ? (
        <div
          className="absolute right-0 bottom-0 left-0 h-2 cursor-ns-resize"
          onPointerDown={(pointerEvent) =>
            drag.onPointerDown(event, box.id, pointerEvent, 'resize')
          }
        />
      ) : null}
    </div>
  );
}
