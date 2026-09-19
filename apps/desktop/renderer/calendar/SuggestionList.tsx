import type { ReactNode } from 'react';

/**
 * The dropdown under a typeahead input, shared by the invitee and location
 * comboboxes so their chrome cannot drift: rows are `role="option"`
 * buttons the input's aria-activedescendant points at, the highlighted
 * row is tinted, stale rows (an earlier query's, see useStaleSearch) show
 * dimmed and never select, and mousedown is swallowed so a click does not
 * blur the input before it lands. Keyboard handling stays on each input.
 */
export function SuggestionList<T>({
  children,
  highlight,
  itemKey,
  items,
  listId,
  onChoose,
  renderItem,
  rowClassName = 'items-baseline gap-2',
  setHighlight,
  stale,
}: {
  /** Footer content: hints, permission asks. */
  children?: ReactNode;
  highlight: number;
  itemKey: (item: T, index: number) => string;
  items: ReadonlyArray<T>;
  listId: string;
  onChoose: (item: T) => void;
  renderItem: (item: T) => ReactNode;
  /** Layout classes for a row's content (flex is always on). */
  rowClassName?: string;
  setHighlight: (index: number) => void;
  stale: boolean;
}) {
  return (
    <div
      className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl"
      id={listId}
      role="listbox"
    >
      {items.map((item, index) => (
        <button
          aria-selected={!stale && index === highlight}
          className={`flex w-full px-3 py-1.5 text-left text-sm ${rowClassName} ${
            stale ? 'opacity-50' : index === highlight ? 'bg-blue-50' : 'hover:bg-neutral-50'
          }`}
          data-stale={stale ? 'true' : undefined}
          id={`${listId}-${index}`}
          key={itemKey(item, index)}
          onClick={() => {
            if (!stale) {
              onChoose(item);
            }
          }}
          onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
          onMouseEnter={() => setHighlight(index)}
          role="option"
          type="button"
        >
          {renderItem(item)}
        </button>
      ))}
      {children}
    </div>
  );
}
