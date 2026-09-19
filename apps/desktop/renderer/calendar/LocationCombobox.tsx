import { useLocationField, type useEventEditorModel } from '@calendar/app-state';
import { useId } from 'react';

const field = 'w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm';

/**
 * The location input with a MapKit typeahead underneath. Free text always
 * stays valid; picking a row writes its label and resolves coordinates for
 * the map. Same keyboard contract as InviteeCombobox: ArrowUp/Down move
 * the highlight, Enter picks it, Escape closes the list without closing
 * the editor. The state machine is useLocationField, shared with iOS.
 */
export function LocationCombobox({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const listId = useId();
  const {
    acceptEnter,
    choose,
    dismiss,
    highlight,
    highlighted,
    moveHighlight,
    open,
    setHighlight,
    setText,
    stale,
    suggestions,
  } = useLocationField({
    location: model.location,
    onPick: (suggestion) => void model.pickPlace(suggestion),
    setLocation: model.setLocation,
  });

  return (
    <div className="relative">
      <input
        aria-activedescendant={open && highlighted ? `${listId}-${highlight}` : undefined}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-label="Location"
        autoComplete="off"
        className={field}
        onBlur={dismiss}
        onChange={(changeEvent) => setText(changeEvent.target.value)}
        onKeyDown={(keyEvent) => {
          if (!open) {
            return;
          }
          if (keyEvent.key === 'ArrowDown') {
            keyEvent.preventDefault();
            moveHighlight(1);
          } else if (keyEvent.key === 'ArrowUp') {
            keyEvent.preventDefault();
            moveHighlight(-1);
          } else if (keyEvent.key === 'Enter') {
            if (acceptEnter()) {
              keyEvent.preventDefault();
            }
          } else if (keyEvent.key === 'Escape') {
            keyEvent.stopPropagation();
            dismiss();
          }
        }}
        placeholder="Location (optional)"
        role="combobox"
        value={model.location}
      />
      {open ? (
        <div
          className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl"
          id={listId}
          role="listbox"
        >
          {suggestions.map((place, index) => (
            <button
              aria-selected={!stale && index === highlight}
              className={`flex w-full flex-col px-3 py-1.5 text-left text-sm ${
                stale ? 'opacity-50' : index === highlight ? 'bg-blue-50' : 'hover:bg-neutral-50'
              }`}
              data-place={place.title}
              data-stale={stale ? 'true' : undefined}
              id={`${listId}-${index}`}
              key={`${place.title}\u001f${place.subtitle ?? ''}`}
              onClick={() => (stale ? undefined : choose(place))}
              onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              role="option"
              type="button"
            >
              <span className="truncate">{place.title}</span>
              {place.subtitle ? (
                <span className="truncate text-xs text-neutral-400">{place.subtitle}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
