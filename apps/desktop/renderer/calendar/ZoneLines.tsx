import { zoneInk } from './zoneInk.ts';

/** An event's times in the other zones, one line each, in the gutter's order and shades. */
export function ZoneLines({
  className = '',
  lines,
}: {
  className?: string;
  lines: ReadonlyArray<string>;
}) {
  return (
    <div className={`text-xs ${className}`} data-testid="event-secondary-times">
      {lines.map((line, index) => (
        <p className={zoneInk(index + 1)} key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}
