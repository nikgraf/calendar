import type { ReactNode } from 'react';

/**
 * Scrolls a `scrollable` list just far enough to show one option. Only the
 * list moves: Element.scrollIntoView would scroll every scrolling
 * ancestor too (the Settings pane under the picker). The input calls it
 * when the arrows move the highlight; a hover or a re-render never
 * scrolls, so a wheel scroll is not pulled back to the highlighted row.
 */
export const revealOption = (listId: string, index: number): void => {
  const list = document.getElementById(listId);
  const option = document.getElementById(`${listId}-${index}`);
  if (!list || !option) {
    return;
  }
  // The list is absolutely positioned, so it is its options' offsetParent.
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  if (top < list.scrollTop) {
    list.scrollTop = top;
  } else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight;
  }
};

/**
 * The dropdown under a typeahead input, shared by the invitee, location
 * and time zone comboboxes so their chrome cannot drift: rows are
 * `role="option"` buttons the input's aria-activedescendant points at,
 * the highlighted row is tinted, stale rows (an earlier query's, see
 * useStaleSearch) show dimmed and never select, and mousedown is
 * swallowed so a click does not blur the input before it lands. Keyboard
 * handling stays on each input. A `scrollable` list (the whole time zone
 * catalog) caps its height and scrolls; its input keeps the highlighted
 * row in view with `revealOption`.
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
  /** A long list: capped height, scrolls (see `revealOption`). */
  scrollable?: boolean;
  setHighlight: (index: number) => void;
  stale: boolean;
}) {
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
