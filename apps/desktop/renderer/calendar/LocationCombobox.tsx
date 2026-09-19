import { useLocationField, type useEventEditorModel } from '@calendar/app-state';
import { useId } from 'react';
import { FIELD_CLASS } from './fieldStyles.ts';
import { SuggestionList } from './SuggestionList.tsx';

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
        className={FIELD_CLASS}
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
        <SuggestionList
          highlight={highlight}
          // MapKit can return two rows with the same title and subtitle.
          itemKey={(place, index) => `${index}:${place.title}`}
          items={suggestions}
          listId={listId}
          onChoose={choose}
          renderItem={(place) => (
            <>
              <span className="truncate">{place.title}</span>
              {place.subtitle ? (
                <span className="truncate text-xs text-neutral-400">{place.subtitle}</span>
              ) : null}
            </>
          )}
          rowClassName="flex-col"
          setHighlight={setHighlight}
          stale={stale}
        />
      ) : null}
    </div>
  );
}
