import { clock, tintClass, week } from './data.ts';
import { TaskCheck } from './TaskCheck.tsx';

const hourStart = 9;
const hourEnd = 17;
const hourHeight = 40;
const gridHeight = (hourEnd - hourStart) * hourHeight;

function top(hour: number): number {
  return (hour - hourStart) * hourHeight;
}

/** The drawn week: day headers, the all-day lane and timed blocks. */
export function WeekGrid() {
  const hours = Array.from({ length: hourEnd - hourStart - 1 }, (_, i) => hourStart + 1 + i);
  return (
    <div className="min-w-0 text-[11px]">
      <div className="grid grid-cols-[40px_repeat(5,minmax(0,1fr))] border-b border-hairline text-ink-secondary">
        <div className="px-1.5 py-2" />
        {week.days.map((day) => (
          <div className="flex items-center gap-1.5 px-1.5 py-2" key={day.label}>
            {day.label}
            {day.today ? (
              <b className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary font-semibold text-on-primary">
                {day.number}
              </b>
            ) : (
              <b className="font-semibold text-ink">{day.number}</b>
            )}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[40px_repeat(5,minmax(0,1fr))] border-b border-hairline text-[10px]">
        <div className="px-1.5 py-1 text-ink-secondary">all-day</div>
        {week.allDay.map((items, i) => (
          <div className="flex flex-col gap-1 p-[3px]" key={i}>
            {items.map((item) =>
              item.kind === 'birthday' ? (
                <span
                  className="flex items-center gap-1.5 rounded-[5px] bg-event-blush px-1.5 py-[3px] font-medium text-on-event-blush"
                  key={item.title}
                >
                  {item.title}
                </span>
              ) : (
                <span
                  className={`flex items-center gap-1.5 rounded-[5px] bg-fill px-1.5 py-[3px] font-medium ${
                    item.done ? 'text-ink-secondary line-through' : ''
                  }`}
                  key={item.title}
                >
                  <TaskCheck done={item.done} size={11} />
                  {item.title}
                </span>
              ),
            )}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[40px_repeat(5,minmax(0,1fr))]" style={{ height: gridHeight }}>
        <div className="relative text-[10px] text-ink-secondary tabular-nums">
          {hours.map((hour) => (
            <span className="absolute right-1.5" key={hour} style={{ top: top(hour) - 6 }}>
              {hour}
            </span>
          ))}
        </div>
        {week.days.map((day, dayIndex) => (
          <div
            className={`relative border-l border-hairline ${day.today ? 'bg-surface-subtle' : ''}`}
            key={day.label}
          >
            {hours.map((hour) => (
              <div
                className="absolute inset-x-0 border-t border-hairline"
                key={hour}
                style={{ top: top(hour) }}
              />
            ))}
            {week.events
              .filter((event) => event.day === dayIndex)
              .map((event) => {
                const blockTop = top(event.start) + 2;
                const blockEnd = Math.min(top(event.end), gridHeight) - 2;
                const short = blockEnd - blockTop < 30;
                return (
                  <div
                    className={`absolute inset-x-[3px] overflow-hidden rounded-[5px] px-[7px] font-medium leading-[1.3] ${
                      short ? 'py-[2px]' : 'py-1'
                    } ${tintClass[event.tint]}`}
                    key={event.title}
                    style={{ height: blockEnd - blockTop, top: blockTop }}
                  >
                    {event.title}
                    {short ? null : (
                      <small className="block text-[10px] font-normal opacity-80">
                        {clock(event.start)} – {clock(event.end)}
                      </small>
                    )}
                  </div>
                );
              })}
            {week.now.day === dayIndex ? (
              <div
                className="absolute inset-x-0 border-t-2 border-primary"
                style={{ top: top(week.now.hour) }}
              >
                <span className="absolute -top-1 -left-1 size-[7px] rounded-full bg-primary" />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
