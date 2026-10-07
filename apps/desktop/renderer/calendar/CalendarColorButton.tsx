import { useGuardedMutations } from '@calendar/app-state';
import { CALENDAR_PALETTE, type CalendarInfo } from '@calendar/core';
import { useState } from 'react';
import { Popover } from '../ui/Popover.tsx';

/**
 * The calendar row's swatch: shows visibility state and opens a color
 * picker in a popover (fixed-positioned, so the sidebar's scroll
 * container cannot clip it).
 */
export function CalendarColorButton({ calendar }: { calendar: CalendarInfo }) {
  const { setCalendarColor } = useGuardedMutations();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

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
        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded"
        // EventKit refuses to recolor a calendar it will not let us write.
        disabled={calendar.provider === 'apple' && calendar.accessRole === 'reader'}
        onClick={(clickEvent) => {
          const rect = clickEvent.currentTarget.getBoundingClientRect();
          setAnchor((current) => (current ? null : { x: rect.left, y: rect.bottom + 4 }));
        }}
        style={{
          backgroundColor: calendar.isVisible ? calendar.colorHex : 'transparent',
          border: `2px solid ${calendar.colorHex}`,
        }}
        type="button"
      />
      <Popover
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
            onChange={(changeEvent) => choose(changeEvent.target.value)}
            type="color"
            value={calendar.colorHex}
          />
        </label>
      </Popover>
    </>
  );
}
