import { MicIcon, SparkleIcon } from './icons.tsx';

/**
 * The Mac editor as a quick-add turn fills it, then a second phrase adds
 * an alert, on a 16 s loop drawn by the `ai-*` keyframes in site.css. Under
 * `prefers-reduced-motion` nothing moves and the finished form shows.
 */
export function AiDemo() {
  return (
    <div
      aria-label="The Mac editor: “Dinner with Jane tomorrow at 7 at Nobu, invite jane@example.com” is typed into the Describe it field, and the title, date, time, place and guest fill in. Then “Remind me 30 minutes before” adds an alert."
      className="ai flex w-full max-w-[440px] flex-col gap-3.5 rounded-[14px] border border-hairline bg-surface p-4 text-[13px]"
      role="img"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">New event</span>
        <span className="text-ink-secondary">Esc</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <SparkleIcon className="text-ink" />
          Describe it
        </span>
        <div className="flex items-start gap-2 rounded-control border border-hairline-strong px-2.5 py-2">
          <span className="relative min-w-0 flex-1 leading-[1.4]">
            <span className="ai-placeholder text-ink-secondary">
              Lunch with Sarah tomorrow at 1
            </span>
            {/* Phrases appear chunk by chunk; inline chunks wrap like the text would at any width. */}
            <span className="ai-p1 block">
              <span className="ai-c1">Dinner with Jane </span>
              <span className="ai-c2">tomorrow at 7 </span>
              <span className="ai-c3">at Nobu, </span>
              <span className="ai-c4">invite jane@example.com</span>
            </span>
            <span className="ai-p2 block">
              <span className="ai-c5">Remind me </span>
              <span className="ai-c6">30 minutes before</span>
            </span>
          </span>
          <MicIcon className="mt-0.5 flex-none text-ink-secondary" size={16} />
          <span className="ai-apply rounded-[6px] bg-primary px-2 py-1 text-xs font-medium text-on-primary">
            Apply
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-hairline pt-3.5">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-ink-secondary">Title</span>
          <span className="ai-f rounded-[6px] px-2.5 py-2">Dinner with Jane</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-ink-secondary">Date</span>
          <span className="ai-f ai-f2 rounded-[6px] px-2.5 py-2">Fri, Oct 30, 2026</span>
        </div>
        <div className="flex gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-ink-secondary">Start</span>
            <span className="ai-f ai-f3 rounded-[6px] px-2.5 py-2">19:00</span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-ink-secondary">End</span>
            <span className="ai-f ai-f3 rounded-[6px] px-2.5 py-2">20:00</span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-ink-secondary">Location</span>
          <span className="ai-f ai-f4 rounded-[6px] px-2.5 py-2">Nobu</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-ink-secondary">Guests</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="ai-f ai-f5 rounded-full px-2.5 py-1 font-medium">
              jane@example.com
            </span>
            <span className="px-0.5 py-1 text-ink-secondary">Add someone</span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-ink-secondary">Alert</span>
          <span className="ai-f ai-f6 rounded-[6px] px-2.5 py-2">30 minutes before</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="ai-reading text-xs text-ink-secondary">Reading…</span>
        <div className="flex gap-2">
          <span className="rounded-control border border-hairline-strong px-3.5 py-2 font-medium">
            Cancel
          </span>
          <span className="rounded-control bg-primary px-3.5 py-2 font-medium text-on-primary">
            Save
          </span>
        </div>
      </div>
    </div>
  );
}
