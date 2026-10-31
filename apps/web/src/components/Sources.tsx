const sources = [
  { dot: 'bg-event-mint-edge', name: 'Google Calendar' },
  { dot: 'bg-event-blue-edge', name: 'Google Tasks' },
  { dot: 'bg-event-lilac-edge', name: 'Apple Calendar' },
  { dot: 'bg-event-blush-edge', name: 'Apple Reminders' },
  { dot: 'border-[1.5px] border-event-lilac-edge', name: 'Outlook and CalDAV via Apple Calendar' },
];

/**
 * The sources the app reads and writes, as a dotted list; the hollow dot
 * is the accounts that arrive through Apple Calendar.
 */
export function Sources() {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-sm text-ink-secondary">
      {sources.map((source) => (
        <li className="inline-flex items-center gap-2" key={source.name}>
          <span aria-hidden="true" className={`size-2 rounded-full ${source.dot}`} />
          {source.name}
        </li>
      ))}
    </ul>
  );
}
