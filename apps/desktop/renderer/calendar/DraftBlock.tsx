import { formatClockTime, type PositionedBox } from '@calendar/core';
import type { DraftOccurrence } from '@calendar/app-state';
import { useTint } from './tint.ts';

/** The hatched fill of a draft, over the tint's edge color: pattern, not brightness, says "not yet". */
export const hatch = (edge: string): string =>
  `repeating-linear-gradient(135deg, transparent 0 4px, ${edge}66 4px 6px)`;

/**
 * A draft from the thread in a day column: hatched, dashed, in the
 * calendar's hue, tagged "Draft" — unmistakably not an event yet. The
 * focused one carries the outline. A click focuses its draft in the
 * panel; the press never reaches the column, so no slot opens under it.
 * A candidate — a free slot a finder phrase offered beside the draft —
 * is the same block fainter: plain fill, dotted, tagged "Option"; a
 * click moves the draft into it.
 */
export function DraftBlock({
  box,
  hourHeight,
  occurrence,
  onClick,
  timeZone,
}: {
  box: PositionedBox;
  hourHeight: number;
  occurrence: DraftOccurrence;
  /** The draft to focus, and for a candidate the slot to move it into. */
  onClick: (draftId: string, slot?: DraftOccurrence['candidate']) => void;
  timeZone: string;
}) {
  const tint = useTint()(occurrence.color);
  const dayMinutes = 24 * 60;
  const pixelHeight = box.height * dayMinutes * (hourHeight / 60);
  const compact = pixelHeight < 28;
  const times = `${formatClockTime(occurrence.startUtc, timeZone)} – ${formatClockTime(occurrence.endUtc, timeZone)}`;
  const { candidate } = occurrence;
  const pick = () => onClick(occurrence.draftId, candidate);
  return (
    <div
      aria-label={candidate ? `Free slot: ${times}` : `Draft: ${occurrence.title}, ${times}`}
      className={`absolute z-10 cursor-pointer overflow-hidden rounded-event border px-1.5 py-0.5 outline-none select-none focus-visible:ring-2 focus-visible:ring-focus ${
        candidate ? 'border-dotted opacity-70' : 'border-dashed'
      } ${occurrence.focused ? 'ring-2 ring-primary' : ''}`}
      data-color={occurrence.color}
      data-draft={occurrence.draftId}
      data-draft-start={occurrence.startTime}
      data-focused={occurrence.focused ? '' : undefined}
      data-testid={candidate ? 'slot-candidate' : 'draft-block'}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        pick();
      }}
      onKeyDown={(keyEvent) => {
        if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          pick();
        }
      }}
      onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
      role="button"
      style={{
        backgroundColor: tint.fill,
        ...(candidate ? {} : { backgroundImage: hatch(tint.edge) }),
        borderColor: tint.edge,
        color: tint.text,
        height: `max(${box.height * 100}%, 14px)`,
        left: `calc(${box.left * 100}% + 1px)`,
        top: `${box.top * 100}%`,
        width: `calc(${box.width * 100}% - 3px)`,
      }}
      tabIndex={0}
      title={
        candidate
          ? `Free slot: ${times} — click to move the draft here`
          : `Draft: ${occurrence.title} · ${formatClockTime(occurrence.startUtc, timeZone)}`
      }
    >
      <p className="flex items-center gap-1 text-xs leading-4 font-medium">
        <span className="min-w-0 flex-1 truncate">{occurrence.title || 'Untitled'}</span>
        <span className="shrink-0 rounded-sm px-1 text-[9px] uppercase opacity-80 ring-1 ring-current">
          {candidate ? 'Option' : 'Draft'}
        </span>
      </p>
      {compact ? null : <p className="truncate text-[10px] opacity-80">{times}</p>}
    </div>
  );
}

/** A draft in the all-day lane: the same hatch and tag as a block, one row high. */
export function DraftChip({
  occurrence,
  onClick,
  style,
}: {
  occurrence: DraftOccurrence;
  onClick: (draftId: string) => void;
  style: { readonly left: string; readonly top: number; readonly width: string };
}) {
  const tint = useTint()(occurrence.color);
  return (
    <div
      className={`absolute flex cursor-pointer items-center gap-1 truncate rounded-event border border-dashed px-1.5 text-xs leading-5 ${
        occurrence.focused ? 'ring-2 ring-primary' : ''
      }`}
      data-color={occurrence.color}
      data-draft={occurrence.draftId}
      data-focused={occurrence.focused ? '' : undefined}
      data-testid="draft-chip"
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onClick(occurrence.draftId);
      }}
      onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
      style={{
        backgroundColor: tint.fill,
        backgroundImage: hatch(tint.edge),
        borderColor: tint.edge,
        color: tint.text,
        ...style,
      }}
      title={`Draft: ${occurrence.title}`}
    >
      <span className="truncate">{occurrence.title || 'Untitled'}</span>
      <span className="shrink-0 rounded-sm px-1 text-[9px] uppercase opacity-80 ring-1 ring-current">
        Draft
      </span>
    </div>
  );
}
