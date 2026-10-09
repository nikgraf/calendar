import {
  DROPPED_NOTICE_TEXT,
  mutationNoticeText,
  useBroadcastNotice,
  useMutationNotice,
} from '@calendar/app-state';
import { DROPPED_NOTICE_KEY } from '@calendar/db/keys';
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { subscribeInvalidations } from './backend.ts';
import { ConflictBanner } from './calendar/ConflictBanner.tsx';
import { noticeArea, type Span } from './noticeArea.ts';

/** A toast's colors: a failure in the danger fill, information inverted against the canvas. */
const TONE = {
  danger: 'bg-danger text-on-danger',
  neutral: 'bg-ink text-canvas',
} as const;

function Toast({
  children,
  testId,
  tone,
}: {
  children: ReactNode;
  testId: string;
  tone: keyof typeof TONE;
}) {
  return (
    <div
      className={`mb-2 max-w-[34rem] rounded-control px-4 py-2 text-center text-sm shadow-lg ${TONE[tone]}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** A failed fire-and-forget write (mutationGuard), or a drop the UI refused. */
function MutationNoticeToast() {
  const shown = useMutationNotice();
  if (!shown) {
    return null;
  }
  // Keyed by the publish: the same refusal twice is new text for the region.
  return (
    <Toast key={shown.id} testId="mutation-toast" tone="danger">
      <div>{mutationNoticeText(shown.value)}</div>
      {shown.value.detail ? (
        <div className="mt-0.5 text-xs opacity-80">{shown.value.detail}</div>
      ) : null}
    </Toast>
  );
}

/**
 * A queued change Google answered with a 4xx retrying cannot fix: the
 * queue dropped it. A 412 is not one of them — it parks the change
 * (ConflictBanner).
 */
function DroppedToast() {
  const shown = useBroadcastNotice(subscribeInvalidations, DROPPED_NOTICE_KEY);
  return shown === null ? null : (
    <Toast key={shown} testId="dropped-toast" tone="neutral">
      {DROPPED_NOTICE_TEXT}
    </Toast>
  );
}

/**
 * The window's notices as one column, anchored to the bottom of the box it
 * is placed in: a failed write on top, a change Google discarded under it,
 * the conflict banner at the foot. The banner holds the anchored edge
 * because it stays until answered — toasts come and go above it and never
 * move its buttons from under the pointer. Each kind holds one notice at a
 * time (a newer one replaces it), so the column never grows past three.
 *
 * The calendar places it in the grid's column, so nothing in it covers the
 * sidebar or the side panel and their controls — while the column is wide
 * enough to read it in. With the sidebar and the editor open in a small
 * window it is not: then the stack spans the narrowest readable width
 * (`noticeArea`), over the sidebar first and into the panel only as far as
 * it must. The settings window places it over the whole window.
 *
 * Screen readers: each toast renders into a live region that is mounted
 * with the stack, empty — a region added together with its text is not
 * reliably read. A failed write is an alert (assertive: it answers what
 * the user just did); a discarded change is a status (polite: it comes
 * from sync, not from the last action), as is a new conflict, told by the
 * banner's own status region.
 */
export function NoticeStack({
  conflicts = false,
  dropped = false,
  placement,
}: {
  /** The conflict banner, and the dropped-change toast: the calendar window's, never Settings'. */
  conflicts?: boolean;
  dropped?: boolean;
  /** `column`: the bottom of the nearest positioned box; `window`: the bottom of the window. */
  placement: 'column' | 'window';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const area = useNoticeArea(ref, placement === 'column');
  return (
    <div
      className={`pointer-events-none bottom-0 z-40 flex flex-col items-center px-4 pt-4 pb-2 ${
        placement === 'column' && !area ? 'absolute inset-x-0' : 'fixed'
      } ${placement === 'window' ? 'inset-x-0' : ''}`}
      data-testid="notice-stack"
      ref={ref}
      style={area ? { left: area.left, width: area.right - area.left } : undefined}
    >
      <div className="flex flex-col items-center" data-testid="notice-alerts" role="alert">
        <MutationNoticeToast />
      </div>
      <div className="flex flex-col items-center" data-testid="notice-status" role="status">
        {dropped ? <DroppedToast /> : null}
      </div>
      {conflicts ? <ConflictBanner /> : null}
    </div>
  );
}

/**
 * The span the stack takes over its column when that is too narrow to read
 * (`noticeArea`), or undefined while the column will do. Measured before
 * paint and again whenever the column's width changes — the window, the
 * sidebar or the panel.
 */
function useNoticeArea(ref: RefObject<HTMLDivElement | null>, enabled: boolean): Span | undefined {
  const [area, setArea] = useState<Span | undefined>(undefined);
  useLayoutEffect(() => {
    const column = ref.current?.parentElement;
    if (!enabled || !column) {
      return;
    }
    const measure = () => {
      const { left, right } = column.getBoundingClientRect();
      const next = noticeArea({ left, right }, window.innerWidth);
      setArea((current) =>
        current?.left === next?.left && current?.right === next?.right ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [enabled, ref]);
  return area;
}
