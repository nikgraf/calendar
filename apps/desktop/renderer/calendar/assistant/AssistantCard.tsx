import { type CardLine, cardLines, type Draft, type FieldChange } from '@calendar/app-state';
import type { ReactNode } from 'react';
import {
  AlertIcon,
  BellIcon,
  ClockIcon,
  GlobeIcon,
  type IconProps,
  MapPinIcon,
  PencilIcon,
  RepeatIcon,
  UsersIcon,
} from '../../ui/icons.tsx';

/** What a step changed, on the card: the `highlight` tint the form marks its fields with. */
const MARK = 'rounded bg-highlight px-1 font-semibold';

const ICONS: Partial<Record<CardLine['field'], (props: IconProps) => ReactNode>> = {
  alert: BellIcon,
  guests: UsersIcon,
  location: MapPinIcon,
  notes: PencilIcon,
  priority: AlertIcon,
  reminders: BellIcon,
  repeat: RepeatIcon,
  url: GlobeIcon,
};

/**
 * A line's value: marked when the step changed it, with what it read
 * before struck through after it. Guests are listed one by one, so only
 * the ones the step invited are marked.
 */
function Value({ line }: { readonly line: CardLine }) {
  if (line.names && line.added) {
    const { added, names } = line;
    return (
      <span data-changed="">
        {names.map((name, index) => (
          <span key={name}>
            {index > 0 ? ', ' : ''}
            <span className={added.includes(name) ? MARK : ''}>{name}</span>
          </span>
        ))}
      </span>
    );
  }
  return (
    <>
      <span className={line.changed ? MARK : ''} data-changed={line.changed ? '' : undefined}>
        {line.text}
      </span>
      {line.was === undefined ? null : (
        <span className="text-ink-secondary line-through">{line.was}</span>
      )}
    </>
  );
}

/**
 * An item as the assistant answers with it: where it goes, its title, the
 * day and the hours, then whatever else it holds (`cardLines`) — each
 * field the step changed marked, the old value struck through beside it.
 * `label` names the version; `footer` holds what can be done about it.
 */
export function AssistantCard({
  changes,
  color,
  container,
  draft,
  footer,
  label,
  timeKept = true,
}: {
  /** What the step the card is of did to the draft; empty marks nothing. */
  readonly changes: ReadonlyArray<FieldChange>;
  /** The calendar's or list's color, when it has one. */
  readonly color?: string | undefined;
  /** The calendar or list the item goes to, by name. */
  readonly container?: string | undefined;
  readonly draft: Draft;
  readonly footer?: ReactNode;
  readonly label: string;
  /** False for a to-do on a list that keeps a due day only: the card shows no time, since none is saved. */
  readonly timeKept?: boolean;
}) {
  const lines = cardLines(draft, changes, timeKept);
  const when = lines.filter((line) => line.field === 'date' || line.field === 'time');
  const rest = lines.filter((line) => line.field !== 'date' && line.field !== 'time');
  const retitled = changes.some((change) => change.field === 'title');
  return (
    <div
      className="flex flex-col gap-2 rounded-popover bg-surface p-3 shadow-sm ring-1 ring-hairline"
      data-draft={draft.id}
      data-testid="assistant-card"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-ink-secondary">
        <span className="flex min-w-0 items-center gap-1.5">
          {color ? (
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          ) : null}
          <span className="truncate">
            {container ?? (draft.item.kind === 'task' ? 'To-do' : 'Event')}
          </span>
        </span>
        <span className="shrink-0 font-semibold tracking-wide uppercase">{label}</span>
      </div>
      <p className="text-base leading-snug font-semibold" data-testid="assistant-card-title">
        <span className={retitled ? MARK : ''} data-changed={retitled ? '' : undefined}>
          {draft.item.prefill.title || 'Untitled'}
        </span>
      </p>
      <div className="flex items-start gap-2 text-sm">
        <ClockIcon className="mt-0.5 shrink-0 text-ink-secondary" size={15} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {when.map((line) => (
            <span
              className="flex items-center gap-2"
              data-testid={`assistant-card-${line.field}`}
              key={line.field}
            >
              <Value line={line} />
            </span>
          ))}
        </div>
      </div>
      {rest.map((line) => {
        const LineIcon = ICONS[line.field] ?? PencilIcon;
        return (
          <div className="flex items-start gap-2 text-sm" key={line.field}>
            <LineIcon className="mt-0.5 shrink-0 text-ink-secondary" size={15} />
            <span
              className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${
                line.field === 'notes' ? 'line-clamp-2' : ''
              }`}
              data-testid={`assistant-card-${line.field}`}
            >
              <Value line={line} />
            </span>
          </div>
        );
      })}
      {footer}
    </div>
  );
}
