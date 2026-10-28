import { MicIcon, SparkleIcon } from '../components/icons.tsx';
import { dotClass } from './data.ts';

function Field({ label, value, wide = true }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 ${wide ? '' : 'min-w-0 flex-1'}`}>
      <span className="text-xs text-ink-secondary">{label}</span>
      <span className="rounded-[6px] bg-highlight px-2.5 py-2">{value}</span>
    </div>
  );
}

/** The Mac editor panel right after a quick-add turn filled it in. */
export function EditorPanel() {
  return (
    <div
      aria-label="The Mac editor panel: a Describe it field reading “Lunch with Sarah tomorrow at 1”, and below it the title, date, start and end filled in and highlighted, a guest chip for Sarah Lindqvist, the Personal calendar, and Cancel and Save buttons"
      className="flex w-full max-w-[360px] flex-col gap-3.5 rounded-[14px] border border-hairline bg-surface p-4 text-[13px] shadow-[0_20px_60px_rgba(48,42,52,0.10)]"
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
        <div className="flex items-center gap-2 rounded-control border border-hairline-strong px-2.5 py-2">
          <span className="min-w-0 flex-1 truncate">Lunch with Sarah tomorrow at 1</span>
          <MicIcon className="flex-none text-ink-secondary" size={16} />
          <span className="rounded-[6px] bg-primary px-2 py-1 text-xs font-medium text-on-primary">
            Apply
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-hairline pt-3.5">
        <Field label="Title" value="Lunch with Sarah" />
        <Field label="Date" value="Wed, Oct 28, 2026" />
        <div className="flex gap-2">
          <Field label="Start" value="13:00" wide={false} />
          <Field label="End" value="14:00" wide={false} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-ink-secondary">Guests</span>
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-full bg-highlight px-2.5 py-1 font-medium">
              Sarah Lindqvist
            </span>
            <span className="px-0.5 py-1 text-ink-secondary">Add someone</span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-ink-secondary">Calendar</span>
          <span className="inline-flex items-center gap-2 rounded-[6px] bg-fill px-2.5 py-2">
            <span className={`size-[9px] rounded-full ${dotClass.mint}`} />
            Personal
          </span>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <span className="rounded-control border border-hairline-strong px-3.5 py-2 font-medium">
          Cancel
        </span>
        <span className="rounded-control bg-primary px-3.5 py-2 font-medium text-on-primary">
          Save
        </span>
      </div>
    </div>
  );
}
