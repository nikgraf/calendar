import { useGuardedMutations } from '@calendar/app-state';
import { CALENDAR_PALETTE, type CalendarInfo } from '@calendar/core';
import { useEffect, useState } from 'react';

/**
 * The calendar row's swatch: shows visibility state and opens a color
 * picker. Rendered as a fixed-position panel so the sidebar's scroll
 * container cannot clip it.
 */
export function CalendarColorButton({ calendar }: { calendar: CalendarInfo }) {
  const { setCalendarColor } = useGuardedMutations();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!anchor) {
      return;
    }
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        setAnchor(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [anchor]);

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
      {anchor ? (
        <>
          <button
            aria-label="Close color picker"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setAnchor(null)}
            type="button"
          />
          <div
            className="fixed z-50 rounded-xl border border-neutral-200 bg-white p-2 shadow-xl"
            role="dialog"
            style={{ left: anchor.x, top: anchor.y }}
          >
            <div className="grid grid-cols-6 gap-1">
              {CALENDAR_PALETTE.map((hex) => (
                <button
                  aria-label={`Set color ${hex}`}
                  className={`size-5 rounded ${
                    hex === calendar.colorHex ? 'ring-2 ring-blue-500 ring-offset-1' : ''
                  }`}
                  key={hex}
                  onClick={() => choose(hex)}
                  style={{ backgroundColor: hex }}
                  type="button"
                />
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-neutral-500">
              Custom
              <input
                aria-label="Custom color"
                className="h-6 w-10 cursor-pointer"
                onChange={(changeEvent) => choose(changeEvent.target.value)}
                type="color"
                value={calendar.colorHex}
              />
            </label>
          </div>
        </>
      ) : null}
    </>
  );
}
