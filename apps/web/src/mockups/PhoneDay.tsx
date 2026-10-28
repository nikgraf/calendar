import { CalendarIcon, CheckCircleIcon, SearchIcon } from '../components/icons.tsx';
import { clock, tintClass, week } from './data.ts';
import { TaskCheck } from './TaskCheck.tsx';

const hourStart = 10;
const hourEnd = 16;
const hourHeight = 52;
const gridHeight = (hourEnd - hourStart) * hourHeight;

function top(hour: number): number {
  return (hour - hourStart) * hourHeight;
}

/** The iPhone app on the same Tuesday, in Day view. */
export function PhoneDay() {
  const today = week.days[week.now.day];
  const allDay = week.allDay[week.now.day] ?? [];
  const events = week.events.filter((event) => event.day === week.now.day);
  const hours = Array.from({ length: hourEnd - hourStart }, (_, i) => hourStart + i);
  return (
    <div
      aria-label="The iPhone app in Day view: the date, a Day · 2 Days · Week · Month switch, a done task and a birthday chip, the day's events, and a tab bar with Calendar, Tasks, Search and a plus button"
      className="flex h-[580px] w-[280px] flex-col overflow-hidden rounded-[44px] border border-hairline-strong bg-surface text-xs shadow-[0_30px_80px_rgba(48,42,52,0.14)]"
      role="img"
    >
      <div className="flex items-center justify-between px-4 pt-14 pb-2.5">
        <div className="flex flex-col">
          <span className="text-xl font-semibold tracking-[-0.01em]">Tuesday {today?.number}</span>
          <span className="text-xs text-ink-secondary">{week.title}</span>
        </div>
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-brand-mint text-[11px] font-semibold text-on-event-mint">
          N
        </span>
      </div>
      <div className="mx-4 flex rounded-control bg-fill p-0.5 text-[11px] font-medium">
        <span className="flex-1 rounded-[6px] bg-surface py-[5px] text-center shadow-[0_1px_2px_rgba(48,42,52,0.12)]">
          Day
        </span>
        {['2 Days', 'Week', 'Month'].map((label) => (
          <span className="flex-1 py-[5px] text-center text-ink-secondary" key={label}>
            {label}
          </span>
        ))}
      </div>
      <div className="mx-4 mt-3 flex flex-wrap gap-1.5">
        {allDay.map((item) =>
          item.kind === 'birthday' ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-[6px] bg-event-blush px-2 py-1 font-medium text-on-event-blush"
              key={item.title}
            >
              {item.title}
            </span>
          ) : (
            <span
              className={`inline-flex items-center gap-1.5 rounded-[6px] bg-fill px-2 py-1 font-medium ${
                item.done ? 'text-ink-secondary line-through' : ''
              }`}
              key={item.title}
            >
              <TaskCheck done={item.done} size={14} />
              {item.title}
            </span>
          ),
        )}
      </div>
      <div className="relative mx-4 mt-3 border-t border-hairline" style={{ height: gridHeight }}>
        {hours.map((hour) => (
          <div className="absolute inset-x-0" key={hour} style={{ top: top(hour) }}>
            {hour === hourStart ? null : <div className="border-t border-hairline" />}
            <span className="absolute top-0.5 left-0 text-[10px] text-ink-secondary">
              {clock(hour)}
            </span>
          </div>
        ))}
        {events.map((event) => (
          <div
            className={`absolute right-0 left-10 overflow-hidden rounded-[6px] px-2 py-1.5 text-xs font-medium leading-[1.3] ${tintClass[event.tint]}`}
            key={event.title}
            style={{ height: top(event.end) - top(event.start) - 4, top: top(event.start) + 3 }}
          >
            {event.title}
            <small className="block text-[11px] font-normal opacity-80">
              {clock(event.start)} – {clock(event.end)}
            </small>
          </div>
        ))}
        <div
          className="absolute right-0 left-9 border-t-2 border-primary"
          style={{ top: top(week.now.hour) }}
        >
          <span className="absolute -top-1 -left-1 size-[7px] rounded-full bg-primary" />
        </div>
      </div>
      <div className="mx-3 mt-auto mb-3.5 flex items-center justify-between gap-2">
        <div className="flex flex-1 items-center justify-around rounded-full bg-fill px-2.5 py-2 text-[10px] font-medium text-ink-secondary">
          <span className="flex flex-col items-center gap-0.5 text-ink">
            <CalendarIcon size={18} strokeWidth={2} />
            Calendar
          </span>
          <span className="flex flex-col items-center gap-0.5">
            <CheckCircleIcon size={18} strokeWidth={2} />
            Tasks
          </span>
        </div>
        <span className="inline-flex size-10 items-center justify-center rounded-full bg-fill text-ink">
          <SearchIcon size={18} />
        </span>
        <span className="inline-flex size-10 items-center justify-center rounded-full bg-primary text-xl font-medium text-on-primary">
          +
        </span>
      </div>
    </div>
  );
}
