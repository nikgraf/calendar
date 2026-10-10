import { type ReactNode, useEffect } from 'react';

/**
 * The dropdown under a typeahead input, shared by the invitee, location
 * and time zone comboboxes so their chrome cannot drift: rows are
 * `role="option"` buttons the input's aria-activedescendant points at,
 * the highlighted row is tinted, stale rows (an earlier query's, see
 * useStaleSearch) show dimmed and never select, and mousedown is
 * swallowed so a click does not blur the input before it lands. Keyboard
 * handling stays on each input. A `scrollable` list (the whole time zone
 * catalog) caps its height and keeps the highlighted row in view as the
 * arrows move it.
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
  scrollable = false,
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
  /** A long list: capped height, scrolls, follows the highlight. */
  scrollable?: boolean;
  setHighlight: (index: number) => void;
  stale: boolean;
}) {
  // `items` is a dependency so a new query (highlight back at 0) scrolls
  // the narrowed list back to its top.
  useEffect(() => {
    if (scrollable) {
      document.getElementById(`${listId}-${highlight}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight, items, listId, scrollable]);

  return (
    <div
      className={`absolute top-full right-0 left-0 z-50 mt-1 rounded-lg border border-hairline bg-surface shadow-xl ${
        scrollable ? 'max-h-72 overflow-y-auto overscroll-contain' : 'overflow-hidden'
      }`}
      data-testid={scrollable ? `${listId}-list` : undefined}
      id={listId}
      role="listbox"
    >
      {items.map((item, index) => (
        <button
          aria-selected={!stale && index === highlight}
          className={`flex w-full px-3 py-1.5 text-left text-sm ${rowClassName} ${
            stale ? 'opacity-50' : index === highlight ? 'bg-selection' : 'hover:bg-surface-subtle'
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
