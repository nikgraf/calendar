import { useGuardedMutations } from '@calendar/app-state';
import { CALENDAR_PALETTE, type CalendarInfo } from '@calendar/core';
import { useState } from 'react';
import { ChevronDownIcon } from './ui/icons.tsx';
import { Popover } from './ui/Popover.tsx';

/**
 * A calendar's color in Settings › Accounts, the one place it changes: a
 * well at the end of the calendar's row that opens a color picker in a
 * popover. The popover hangs from the well's right edge, under it or,
 * for a row low in the fixed-height window, above it. It opens with focus
 * on the current color: its swatch, or the Custom field for a color off
 * the palette.
 */
export function CalendarColorButton({ calendar }: { calendar: CalendarInfo }) {
  const { setCalendarColor } = useGuardedMutations();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  // EventKit refuses to recolor a calendar it will not let us write.
  const readOnly = calendar.provider === 'apple' && calendar.accessRole === 'reader';

  const choose = (colorHex: string) => {
    setAnchor(null);
    void setCalendarColor({
      accountId: calendar.accountId,
      calendarId: calendar.id,
      colorHex,
    });
  };

  return (
    <>
      <button
        aria-label={`Change color: ${calendar.summary}`}
        className="flex shrink-0 items-center gap-1 rounded-control border border-hairline px-1.5 py-1 text-ink-secondary hover:bg-fill hover:text-ink disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
        disabled={readOnly}
        onClick={(clickEvent) => {
          const rect = clickEvent.currentTarget.getBoundingClientRect();
          setAnchor((current) =>
            current ? null : { above: rect.top - 4, x: rect.right, y: rect.bottom + 4 },
          );
        }}
        title={readOnly ? 'Apple Calendar does not allow changing this calendar' : 'Change color'}
        type="button"
      >
        <span
          aria-hidden
          className="size-3.5 rounded-full"
          style={{ backgroundColor: calendar.colorHex }}
        />
        <ChevronDownIcon size={12} />
      </button>
      <Popover
        align="end"
        anchor={anchor}
        closeLabel="Close color picker"
        label={`Color of ${calendar.summary}`}
        onClose={() => setAnchor(null)}
      >
        <div className="grid grid-cols-6 gap-1">
          {CALENDAR_PALETTE.map((hex) => (
            <button
              aria-label={`Set color ${hex}`}
              className={`size-5 rounded ${
                hex === calendar.colorHex ? 'ring-2 ring-focus ring-offset-1' : ''
              }`}
              data-initial-focus={hex === calendar.colorHex || undefined}
              key={hex}
              onClick={() => choose(hex)}
              style={{ backgroundColor: hex }}
              type="button"
            />
          ))}
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-ink-secondary">
          Custom
          <input
            aria-label="Custom color"
            className="h-6 w-10 cursor-pointer"
            data-initial-focus={!CALENDAR_PALETTE.includes(calendar.colorHex) || undefined}
            onChange={(changeEvent) => choose(changeEvent.target.value)}
            type="color"
            value={calendar.colorHex}
          />
        </label>
      </Popover>
    </>
  );
}
