import { searchTimeZones, type TimeZoneMatch, zoneSlug } from '@calendar/core';
import { useState } from 'react';
import { SuggestionList } from './calendar/SuggestionList.tsx';
import { SETTINGS_BUTTON_CLASS } from './ui/buttonStyles.ts';

const LIST_ID = 'time-zone-options';

/**
 * A search box over the zone catalog for the settings section. It opens
 * on the whole catalog in a scrolling list; typing a city, region or id
 * narrows it. Pick with the arrows and Enter or a click; Cancel or Escape
 * closes it. The zones already listed are left out so a pick always adds
 * one.
 */
export function TimeZonePicker({
  exclude,
  onCancel,
  onPick,
}: {
  exclude: ReadonlyArray<string>;
  onCancel: () => void;
  onPick: (zone: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const matches = searchTimeZones(query, exclude);
  const choose = (match: TimeZoneMatch) => onPick(match.id);

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            aria-activedescendant={matches.length > 0 ? `${LIST_ID}-${highlight}` : undefined}
            aria-autocomplete="list"
            aria-controls={LIST_ID}
            aria-expanded={matches.length > 0}
            aria-label="Search time zones"
            autoFocus
            className="w-full rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm"
            onChange={(change) => {
              setQuery(change.target.value);
              setHighlight(0);
            }}
            onKeyDown={(keyEvent) => {
              if (keyEvent.key === 'ArrowDown') {
                keyEvent.preventDefault();
                setHighlight((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
              } else if (keyEvent.key === 'ArrowUp') {
                keyEvent.preventDefault();
                setHighlight((index) => Math.max(index - 1, 0));
              } else if (keyEvent.key === 'Enter') {
                keyEvent.preventDefault();
                const match = matches[highlight];
                if (match) {
                  choose(match);
                }
              } else if (keyEvent.key === 'Escape') {
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                onCancel();
              }
            }}
            placeholder="City or region"
            role="combobox"
            type="text"
            value={query}
          />
          {matches.length > 0 ? (
            <SuggestionList
              highlight={highlight}
              itemKey={(match) => match.id}
              items={matches}
              listId={LIST_ID}
              onChoose={choose}
              renderItem={(match) => (
                <>
                  <span data-testid={`time-zone-option-${zoneSlug(match.id)}`}>{match.city}</span>
                  <span className="text-xs text-ink-secondary">{match.id}</span>
                </>
              )}
              scrollable
              setHighlight={setHighlight}
              stale={false}
            />
          ) : null}
        </div>
        <button
          className={`${SETTINGS_BUTTON_CLASS} shrink-0`}
          data-testid="time-zone-cancel"
          onClick={onCancel}
          onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
          type="button"
        >
          Cancel
        </button>
      </div>
      {matches.length === 0 ? (
        <p className="mt-2 text-xs text-ink-secondary" data-testid="time-zone-no-match">
          No time zone matches “{query.trim()}”.
        </p>
      ) : null}
    </div>
  );
}
