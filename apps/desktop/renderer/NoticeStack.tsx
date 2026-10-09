import {
  DROPPED_NOTICE_TEXT,
  mutationNoticeText,
  useBroadcastNotice,
  useMutationNotice,
} from '@calendar/app-state';
import { DROPPED_NOTICE_KEY } from '@calendar/db/keys';
import type { ReactNode } from 'react';
import { subscribeInvalidations } from './backend.ts';
import { ConflictBanner } from './calendar/ConflictBanner.tsx';

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
 * The calendar places it in the grid's column, so nothing in it can cover
 * the sidebar or the side panel and their controls, whatever the window's
 * width; the settings window places it over the whole window.
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
  return (
    <div
      className={`pointer-events-none inset-x-0 bottom-0 z-40 flex flex-col items-center px-4 pt-4 pb-2 ${
        placement === 'column' ? 'absolute' : 'fixed'
      }`}
      data-testid="notice-stack"
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
