import { useUpNext } from '@calendar/app-state';
import { type EventRecord, formatClockTime } from '@calendar/core';
import { Button } from '../../ui/Button.tsx';
import { VideoIcon } from '../../ui/icons.tsx';

const startsIn = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) {
    return 'Now';
  }
  if (minutes < 60) {
    return `In ${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  return `In ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
};

/**
 * The rail's top card: the next appointment that has not ended, with its
 * Join button when it has a meeting link. Clicking the card opens the
 * inspector. Nothing is drawn when the day has no appointment left.
 */
export function UpNextCard({
  onOpen,
  timeZone,
}: {
  onOpen: (event: EventRecord) => void;
  timeZone: string;
}) {
  const next = useUpNext(timeZone);
  if (!next) {
    return null;
  }
  const { event, joinUrl, startsInMs } = next;
  return (
    <section className="px-3 pt-3" data-testid="up-next">
      <div className="rounded-event bg-event-lilac p-3 text-on-event-lilac">
        <button className="w-full text-left" onClick={() => onOpen(event)} type="button">
          <p className="text-[11px] font-semibold tracking-wide uppercase opacity-70">
            Up next · {startsIn(startsInMs)}
          </p>
          <p className="mt-0.5 truncate text-sm font-semibold">{event.title}</p>
          <p className="text-xs opacity-80">
            {formatClockTime(event.startUtc, timeZone)} – {formatClockTime(event.endUtc, timeZone)}
          </p>
        </button>
        {joinUrl ? (
          <Button
            className="mt-2 w-full"
            onClick={() => window.open(joinUrl, '_blank', 'noopener')}
            size="sm"
            variant="primary"
          >
            <VideoIcon size={14} />
            Join meeting
          </Button>
        ) : null}
      </div>
    </section>
  );
}
