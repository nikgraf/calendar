import {
  type CalendarInfo,
  calendarKey,
  type SearchFilterField,
  searchChipId,
  searchFilterChips,
  type SearchNames,
  type SearchQuery,
  type TaskListInfo,
  toggleSearchKey,
  withoutSearchFilter,
} from '@calendar/core';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button } from '../../ui/Button.tsx';
import { FIELD_CLASS } from '../../ui/fieldStyles.ts';
import { PlusIcon, XIcon } from '../../ui/icons.tsx';
import { Popover } from '../../ui/Popover.tsx';
import { SegmentedControl } from '../../ui/SegmentedControl.tsx';
import { useFlash } from '../../ui/useFlash.ts';

/** The filters a chip edits, in the order "+ Filter" offers them. */
const FIELDS: ReadonlyArray<{ readonly field: SearchFilterField; readonly label: string }> = [
  { field: 'dates', label: 'When' },
  { field: 'kind', label: 'Events or tasks' },
  { field: 'calendar', label: 'Calendars' },
  { field: 'list', label: 'Lists' },
  { field: 'location', label: 'Place' },
  { field: 'people', label: 'People' },
  { field: 'allDay', label: 'All-day or timed' },
];

const POPOVER_WIDTH = 272;

type Editing = {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly field: SearchFilterField | 'add';
};

/** One filter's chip; it tints and fades back when a turn put it there or changed it. */
function FilterChip({ children, flash }: { children: ReactNode; flash: string | null }) {
  const ref = useFlash<HTMLSpanElement>(flash);
  return (
    <span className="inline-flex items-center rounded-md bg-fill text-xs" ref={ref}>
      {children}
    </span>
  );
}

/**
 * The search's filters as chips under the field: a click edits one in a
 * popover, × takes it away, "+ Filter" adds one, "Clear" resets the words,
 * the filters and the turns. Every edit is the user's own — not a turn;
 * the chips a turn added or changed flash (`flash`).
 */
export function SearchFilterChips({
  calendars,
  flash,
  names,
  onChange,
  onClear,
  query,
  showClear,
  taskLists,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  /** The newest turn's chips, while their flash plays (`useSearchThread().flash`). */
  flash: { readonly chips: ReadonlySet<string>; readonly key: string } | null;
  names: SearchNames;
  onChange: (query: SearchQuery) => void;
  onClear: () => void;
  query: SearchQuery;
  showClear: boolean;
  taskLists: ReadonlyArray<TaskListInfo>;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  // The people field as typed (commas and all); the query holds the names.
  const [peopleText, setPeopleText] = useState('');
  const chips = searchFilterChips(query, names);

  const open = (field: Editing['field'], target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setPeopleText((query.people ?? []).join(', '));
    setEditing({
      anchor: {
        x: Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8))),
        y: Math.round(rect.bottom + 4),
      },
      field,
    });
  };

  const editor = (field: Editing['field']) => {
    switch (field) {
      case 'add':
        return (
          <div className="flex flex-col">
            {FIELDS.map((entry) => (
              <button
                className="rounded-control px-2 py-1 text-left text-sm hover:bg-fill"
                data-testid={`search-add-${entry.field}`}
                key={entry.field}
                onClick={() =>
                  setEditing((current) => current && { ...current, field: entry.field })
                }
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
        );
      case 'dates':
        return (
          <div className="flex flex-col gap-2 text-xs">
            <label className="flex items-center justify-between gap-2">
              From
              <input
                autoFocus
                className={`${FIELD_CLASS} w-40`}
                data-testid="search-filter-from"
                onChange={(input) =>
                  onChange({
                    ...withoutSearchFilter(query, 'dates'),
                    ...(input.target.value ? { from: input.target.value } : {}),
                    ...(query.to ? { to: query.to } : {}),
                  })
                }
                type="date"
                value={query.from ?? ''}
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              To
              <input
                className={`${FIELD_CLASS} w-40`}
                data-testid="search-filter-to"
                onChange={(input) =>
                  onChange({
                    ...withoutSearchFilter(query, 'dates'),
                    ...(query.from ? { from: query.from } : {}),
                    ...(input.target.value ? { to: input.target.value } : {}),
                  })
                }
                type="date"
                value={query.to ?? ''}
              />
            </label>
          </div>
        );
      case 'kind':
        return (
          <SegmentedControl
            className="w-full"
            grow
            label="Events or tasks"
            onChange={(value: 'any' | 'event' | 'task') =>
              onChange(
                value === 'any' ? withoutSearchFilter(query, 'kind') : { ...query, kind: value },
              )
            }
            options={[
              { label: 'Both', testId: 'search-filter-kind-any', value: 'any' as const },
              { label: 'Events', testId: 'search-filter-kind-event', value: 'event' as const },
              { label: 'Tasks', testId: 'search-filter-kind-task', value: 'task' as const },
            ]}
            size="sm"
            value={query.kind ?? 'any'}
          />
        );
      case 'allDay':
        return (
          <SegmentedControl
            className="w-full"
            grow
            label="All-day or timed"
            onChange={(value: 'allDay' | 'any' | 'timed') =>
              onChange(
                value === 'any'
                  ? withoutSearchFilter(query, 'allDay')
                  : { ...query, allDay: value === 'allDay' },
              )
            }
            options={[
              { label: 'Any', testId: 'search-filter-allday-any', value: 'any' as const },
              { label: 'All-day', testId: 'search-filter-allday-allDay', value: 'allDay' as const },
              { label: 'Timed', testId: 'search-filter-allday-timed', value: 'timed' as const },
            ]}
            size="sm"
            value={query.allDay === undefined ? 'any' : query.allDay ? 'allDay' : 'timed'}
          />
        );
      case 'calendar':
        return (
          <div className="flex max-h-64 flex-col overflow-y-auto">
            {calendars
              .filter((calendar) => calendar.isVisible)
              .map((calendar) => {
                const key = calendarKey(calendar);
                return (
                  <label className="flex items-center gap-2 px-1 py-1 text-sm" key={key}>
                    <input
                      checked={query.calendars?.includes(key) ?? false}
                      data-testid={`search-filter-calendar-${key}`}
                      onChange={() => {
                        const next = toggleSearchKey(query.calendars, key);
                        onChange(
                          next.length > 0
                            ? { ...query, calendars: next }
                            : withoutSearchFilter(query, 'calendar'),
                        );
                      }}
                      type="checkbox"
                    />
                    <span className="truncate">{calendar.summary}</span>
                  </label>
                );
              })}
          </div>
        );
      case 'list':
        return (
          <div className="flex max-h-64 flex-col overflow-y-auto">
            {taskLists
              .filter((list) => list.isVisible)
              .map((list) => {
                const key = `${list.accountId}:${list.id}`;
                return (
                  <label className="flex items-center gap-2 px-1 py-1 text-sm" key={key}>
                    <input
                      checked={query.lists?.includes(key) ?? false}
                      data-testid={`search-filter-list-${key}`}
                      onChange={() => {
                        const next = toggleSearchKey(query.lists, key);
                        onChange(
                          next.length > 0
                            ? { ...query, lists: next }
                            : withoutSearchFilter(query, 'list'),
                        );
                      }}
                      type="checkbox"
                    />
                    <span className="truncate">{list.title}</span>
                  </label>
                );
              })}
          </div>
        );
      case 'location':
        return (
          <input
            aria-label="Place"
            autoFocus
            className={FIELD_CLASS}
            data-testid="search-filter-location"
            onChange={(input) =>
              onChange(
                input.target.value.trim()
                  ? { ...query, location: input.target.value }
                  : withoutSearchFilter(query, 'location'),
              )
            }
            placeholder="A place the event is at"
            value={query.location ?? ''}
          />
        );
      case 'people':
        return (
          <input
            aria-label="People"
            autoFocus
            className={FIELD_CLASS}
            data-testid="search-filter-people"
            onChange={(input) => {
              setPeopleText(input.target.value);
              const people = input.target.value
                .split(',')
                .map((person) => person.trim())
                .filter((person) => person !== '');
              onChange(
                people.length > 0 ? { ...query, people } : withoutSearchFilter(query, 'people'),
              );
            }}
            placeholder="Names or addresses, comma-separated"
            value={peopleText}
          />
        );
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="search-chips">
      {chips.map((chip) => (
        <FilterChip
          flash={flash?.chips.has(searchChipId(chip)) ? flash.key : null}
          key={searchChipId(chip)}
        >
          <button
            className="rounded-l-md px-2 py-0.5 hover:bg-hairline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            data-testid={`search-chip-${chip.field}${chip.key === undefined ? '' : `-${chip.key}`}`}
            onClick={(click) => open(chip.field, click.currentTarget)}
            type="button"
          >
            {chip.label}
          </button>
          <button
            aria-label={`Remove ${chip.label}`}
            className="rounded-r-md px-1 py-0.5 text-ink-secondary hover:bg-hairline hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            data-testid="search-chip-remove"
            onClick={() => onChange(withoutSearchFilter(query, chip.field, chip.key))}
            type="button"
          >
            <XIcon size={10} />
          </button>
        </FilterChip>
      ))}
      <button
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-secondary hover:bg-fill hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        data-testid="search-add-filter"
        onClick={(click) => open('add', click.currentTarget)}
        type="button"
      >
        <PlusIcon size={10} />
        Filter
      </button>
      {showClear ? (
        <Button data-testid="search-clear" onClick={onClear} size="sm" variant="ghost">
          Clear
        </Button>
      ) : null}
      <Popover
        anchor={editing?.anchor ?? null}
        className="w-68"
        closeLabel="Close filter"
        label="Edit filter"
        onClose={() => setEditing(null)}
      >
        {editing ? editor(editing.field) : null}
      </Popover>
    </div>
  );
}
