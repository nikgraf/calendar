import { useDragPointer, type useEventDrag } from '../useEventDrag.ts';

/**
 * The chip that follows the pointer while a panel row is dragged: the row
 * has no place on the grid to move, so this stands in until the drop
 * indicator takes over. Never a pointer target itself.
 */
export function DragGhost({ drag }: { drag: ReturnType<typeof useEventDrag> }) {
  const pointer = useDragPointer(drag);
  const label = drag.preview?.from === 'panel' ? drag.preview.label : undefined;
  if (!pointer || label === undefined) {
    return null;
  }
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-56 truncate rounded-event bg-fill px-2 py-0.5 text-xs text-ink shadow-lg ring-1 ring-primary"
      data-testid="drag-ghost"
      style={{ left: pointer.x + 12, top: pointer.y - 10 }}
    >
      {label}
    </div>
  );
}
