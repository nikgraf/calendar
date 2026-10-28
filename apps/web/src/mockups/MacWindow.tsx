import { SearchIcon } from '../components/icons.tsx';
import { calendars, dotClass, lists, tasks, upNext, week } from './data.ts';
import { TaskCheck } from './TaskCheck.tsx';
import { WeekGrid } from './WeekGrid.tsx';

const monthRows: ReadonlyArray<ReadonlyArray<number>> = [
  [28, 29, 30, 1, 2, 3, 4],
  [5, 6, 7, 8, 9, 10, 11],
  [12, 13, 14, 15, 16, 17, 18],
  [19, 20, 21, 22, 23, 24, 25],
  [26, 27, 28, 29, 30, 31, 1],
];

function MiniMonth() {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold">October</div>
      <div className="grid grid-cols-7 text-center text-[9px] text-ink-secondary tabular-nums">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span className="py-0.5 font-medium" key={i}>
            {d}
          </span>
        ))}
        {monthRows.map((row, r) =>
          row.map((n, c) => {
            const outside = (r === 0 && n > 7) || (r === 4 && n < 7);
            const thisWeek = r === 4 && c < 5;
            const today = r === 4 && n === 27;
            return (
              <span
                className={`py-0.5 ${
                  today
                    ? 'rounded bg-primary text-on-primary'
                    : thisWeek
                      ? `bg-selection text-ink ${c === 0 ? 'rounded-l' : c === 4 ? 'rounded-r' : ''}`
                      : outside
                        ? 'text-ink-tertiary/60'
                        : ''
                }`}
                key={`${r}-${c}`}
              >
                {n}
              </span>
            );
          }),
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[10px] font-semibold tracking-[0.04em] text-ink-secondary uppercase">
      {children}
    </div>
  );
}

/** The Mac app: toolbar, sidebar, the week and the Up next rail. */
export function MacWindow() {
  return (
    // The window keeps 70 px day columns at 644 px; below that (phones) it
    // scrolls sideways. Wider, the wrapper stays open so the shadow shows.
    <div className="max-md:overflow-x-auto">
      <div
        aria-label="The Mac app in week view: a sidebar with the mini month, calendars and lists; the week with tasks in the all-day lane and events from four sources; an Up next rail with tasks"
        className="min-w-[644px] overflow-hidden rounded-[14px] border border-hairline bg-surface text-xs shadow-[0_30px_80px_rgba(48,42,52,0.12),0_2px_6px_rgba(48,42,52,0.06)]"
        role="img"
      >
        <div className="flex items-center justify-between gap-3 border-b border-hairline bg-surface-subtle px-3.5 py-2.5">
          <div className="flex items-center gap-3.5">
            <div className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-highlight" />
              <span className="size-2.5 rounded-full bg-highlight" />
              <span className="size-2.5 rounded-full bg-highlight" />
            </div>
            <span className="text-[13px] font-semibold">{week.title}</span>
            <span className="inline-flex gap-0.5 text-ink-secondary">
              <span className="px-1.5">‹</span>
              <span className="px-1.5">Today</span>
              <span className="px-1.5">›</span>
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <div className="flex rounded-[7px] bg-fill p-0.5 text-[11px] font-medium">
              <span className="px-2 py-[3px] text-ink-secondary">Day</span>
              <span className="rounded-[5px] bg-surface px-2 py-[3px] shadow-[0_1px_2px_rgba(48,42,52,0.12)]">
                Week
              </span>
              <span className="px-2 py-[3px] text-ink-secondary">Month</span>
            </div>
            <SearchIcon className="text-ink-secondary" size={16} />
            <span className="rounded-[6px] bg-primary px-2 py-1 text-[11px] font-medium text-on-primary">
              + New
            </span>
          </div>
        </div>
        <div className="grid grid-cols-[120px_minmax(0,1fr)_140px]">
          <aside className="flex flex-col gap-3.5 border-r border-hairline bg-surface-subtle p-3">
            <MiniMonth />
            <div className="flex flex-col gap-1.5">
              <SectionLabel>Calendars</SectionLabel>
              {calendars.map((calendar) => (
                <div className="flex items-center gap-[7px] text-[11px]" key={calendar.name}>
                  <span className={`size-[9px] rounded-full ${dotClass[calendar.tint]}`} />
                  {calendar.name}
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <SectionLabel>Lists</SectionLabel>
              {lists.map((list) => (
                <div className="flex items-center gap-[7px] text-[11px]" key={list}>
                  <TaskCheck size={9} />
                  {list}
                </div>
              ))}
            </div>
          </aside>
          <WeekGrid />
          <aside className="flex flex-col gap-3.5 border-l border-hairline bg-surface-subtle p-3">
            <div className="flex flex-col gap-1.5">
              <SectionLabel>Up next</SectionLabel>
              {upNext.map((item) => (
                <div
                  className="flex flex-col gap-0.5 rounded-[8px] border border-hairline bg-surface px-2.5 py-2"
                  key={item.title}
                >
                  <span className="text-[11px] font-semibold">{item.title}</span>
                  <span className="text-[10px] text-ink-secondary">{item.detail}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <SectionLabel>Tasks</SectionLabel>
              {tasks.map((task) => (
                <div
                  className={`flex items-center gap-[7px] text-[11px] ${
                    task.done ? 'text-ink-secondary line-through' : ''
                  }`}
                  key={task.title}
                >
                  <TaskCheck done={task.done} size={14} />
                  {task.title}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
