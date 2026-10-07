import {
  definitionOf,
  draftOf,
  googleAccountsForNewCalendar,
  hasSource,
  type MirrorDraft,
  mirrorDestinationOptions,
  mirrorDraftIssue,
  mirrorSourceOptions,
  newMirrorDraft,
  refLabel,
  refSlug,
  useAccounts,
  useBackendMutations,
  useCalendars,
  useMirrors,
  useTaskLists,
  useTimeZoneSettings,
  withSourceToggled,
} from '@calendar/app-state';
import {
  describeMirrorStatus,
  MIRROR_COPY,
  MIRROR_MAX_MONTHS,
  MIRROR_PRESET_COPY,
  MIRROR_PRESET_ORDER,
  type MirrorPreset,
  mirrorPresetOf,
  type MirrorPreview,
  type MirrorSample,
  type MirrorView,
  mirrorRefKey,
  Temporal,
  withMirrorPreset,
} from '@calendar/core';
import { useEffect, useState } from 'react';
import { Dialog } from './Dialog.tsx';

const BUTTON =
  'rounded-lg border border-hairline-strong px-3 py-1.5 text-sm hover:bg-surface-subtle disabled:opacity-50';
const PRIMARY =
  'rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50';
const FIELD = 'w-full rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm';
const LABEL = 'text-xs font-medium text-ink-secondary';

const zoned = (ms: number, timeZone: string): Temporal.ZonedDateTime =>
  Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone);
const clock = (at: Temporal.ZonedDateTime): string =>
  at.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "Thu 12 Mar, 10:00–11:00" or "Thu 12 Mar, all day", in the mirror's zone. */
const sampleTime = (sample: MirrorSample, timeZone: string): string => {
  if (sample.allDay) {
    const day = Temporal.PlainDate.from(sample.startDate ?? '1970-01-01');
    return `${day.toLocaleString('en-US', { day: 'numeric', month: 'short', weekday: 'short' })}, all day`;
  }
  const start = zoned(sample.startUtc, timeZone);
  const day = start.toLocaleString('en-US', { day: 'numeric', month: 'short', weekday: 'short' });
  return `${day}, ${clock(start)}–${clock(zoned(sample.endUtc, timeZone))}`;
};

const relativeTime = (epochMs: number): string => {
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  return new Date(epochMs).toLocaleString(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  });
};

function MirrorRow({
  onDelete,
  onEdit,
  view,
}: {
  onDelete: () => void;
  onEdit: () => void;
  view: MirrorView;
}) {
  const mutations = useBackendMutations();
  const { definition, enabled, status } = view;
  const tone =
    status.state === 'paused'
      ? 'text-red-700'
      : status.state === 'waiting'
        ? 'text-amber-700'
        : 'text-ink-secondary';
  return (
    <li
      className="rounded-lg border border-hairline p-3"
      data-state={status.state}
      data-testid={`mirror-row-${definition.id}`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{definition.name}</p>
          <p className="truncate text-xs text-ink-secondary">
            {definition.sources.map(refLabel).join(', ')} → {refLabel(definition.destination)} ·{' '}
            {MIRROR_PRESET_COPY[mirrorPresetOf(definition)].title}
          </p>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input
            checked={enabled}
            data-testid={`mirror-enabled-${definition.id}`}
            onChange={(input) =>
              void mutations.setMirrorEnabled({ enabled: input.target.checked, id: definition.id })
            }
            type="checkbox"
          />
          On this device
        </label>
        <button className={BUTTON} onClick={onEdit} type="button">
          Edit
        </button>
        <button
          className={BUTTON}
          data-testid={`mirror-delete-${definition.id}`}
          onClick={onDelete}
          type="button"
        >
          Delete
        </button>
      </div>
      <p className={`mt-2 text-xs ${tone}`} data-testid={`mirror-status-${definition.id}`}>
        {describeMirrorStatus(status)}
        {status.lastRunAt === undefined || status.state === 'off'
          ? ''
          : ` Last run ${relativeTime(status.lastRunAt)}.`}
        {status.state === 'off' ? null : (
          <button
            className="ml-2 text-primary hover:underline"
            data-testid={`mirror-run-${definition.id}`}
            onClick={() => void mutations.runMirrorsNow(undefined)}
            type="button"
          >
            Run now
          </button>
        )}
      </p>
    </li>
  );
}

function NewCalendarDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (ref: MirrorDraft['destination']) => void;
}) {
  const mutations = useBackendMutations();
  const accounts = googleAccountsForNewCalendar(useAccounts());
  const [title, setTitle] = useState('');
  const [where, setWhere] = useState<string>(accounts[0]?.id ?? 'apple');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const ref = await mutations.createMirrorCalendar({
        target:
          where === 'apple'
            ? { kind: 'apple', title: title.trim() }
            : { accountId: where, kind: 'google', title: title.trim() },
      });
      onCreated(ref);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  return (
    <Dialog label="New calendar" onClose={onClose} panelClassName="w-96 rounded-xl bg-surface p-4">
      <h3 className="font-medium">New calendar</h3>
      <p className="mt-1 text-sm text-ink-secondary">
        A calendar of its own for the copies. {MIRROR_COPY.sharing}
      </p>
      <label className={`${LABEL} mt-3 block`}>
        Name
        <input
          autoFocus
          className={`${FIELD} mt-1`}
          data-testid="mirror-new-calendar-title"
          onChange={(input) => setTitle(input.target.value)}
          value={title}
        />
      </label>
      <label className={`${LABEL} mt-3 block`}>
        Where
        <select
          className={`${FIELD} mt-1`}
          data-testid="mirror-new-calendar-where"
          onChange={(input) => setWhere(input.target.value)}
          value={where}
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              Google · {account.email}
            </option>
          ))}
          <option value="apple">iCloud (Apple Calendar)</option>
        </select>
      </label>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button className={BUTTON} onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className={PRIMARY}
          data-testid="mirror-new-calendar-create"
          disabled={busy || title.trim() === ''}
          onClick={() => void create()}
          type="button"
        >
          Create
        </button>
      </div>
    </Dialog>
  );
}

function MirrorEditor({
  initial,
  mirrors,
  onClose,
}: {
  initial: MirrorDraft;
  mirrors: ReadonlyArray<MirrorView>;
  onClose: () => void;
}) {
  const mutations = useBackendMutations();
  const accounts = useAccounts();
  const calendars = useCalendars();
  const taskLists = useTaskLists();
  const [draft, setDraft] = useState(initial);
  const [advanced, setAdvanced] = useState(mirrorPresetOf(initial) === 'custom');
  const [previewed, setPreviewed] = useState<{ key: string; result: MirrorPreview } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const sources = mirrorSourceOptions({ accounts, calendars, taskLists });
  const destinations = mirrorDestinationOptions({ accounts, calendars, draft, mirrors });
  const issue = mirrorDraftIssue(draft);
  const preset = mirrorPresetOf(draft);

  // What the people the destination is shared with would see, as the draft
  // stands. Keyed by the draft it was computed for, so a stale answer is
  // never shown for the draft of the moment.
  const previewKey = issue === undefined ? JSON.stringify(definitionOf(draft, 0)) : undefined;
  useEffect(() => {
    const definition = previewKey === undefined ? undefined : definitionOf(draft, 0);
    if (definition === undefined || previewKey === undefined) {
      return;
    }
    let live = true;
    const handle = setTimeout(() => {
      void mutations.previewMirror({ definition }).then(
        (result) => live && setPreviewed({ key: previewKey, result }),
        () => undefined,
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(handle);
    };
    // The key is the draft's serialisation; the draft itself would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, mutations]);
  const preview = previewed !== null && previewed.key === previewKey ? previewed.result : null;

  const save = async () => {
    const definition = definitionOf(draft, Date.now());
    if (definition === undefined) {
      return;
    }
    setSaving(true);
    try {
      await mutations.saveMirror({ definition });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };

  const groups = [...new Set(sources.map((option) => option.group))];
  const destinationKey = draft.destination === undefined ? '' : mirrorRefKey(draft.destination);
  const destinationKnown = destinations.some((option) => option.key === destinationKey);

  return (
    <div
      className="mt-3 rounded-lg border border-hairline bg-surface-subtle p-3"
      data-testid="mirror-editor"
    >
      <label className={`${LABEL} block`}>
        Name
        <input
          autoFocus
          className={`${FIELD} mt-1`}
          data-testid="mirror-name"
          onChange={(input) => setDraft({ ...draft, name: input.target.value })}
          placeholder="Family calendar"
          value={draft.name}
        />
      </label>

      <p className={`${LABEL} mt-3`}>Copy from</p>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
        {groups.map((group) => (
          <div key={group}>
            <p className="text-xs text-ink-secondary">{group}</p>
            {sources
              .filter((option) => option.group === group)
              .map((option) => (
                <label className="flex items-center gap-1.5 text-sm" key={option.key}>
                  <input
                    checked={hasSource(draft, option.ref)}
                    data-testid={`mirror-source-${refSlug(option.key)}`}
                    onChange={() => setDraft(withSourceToggled(draft, option.ref))}
                    type="checkbox"
                  />
                  {option.label}
                </label>
              ))}
          </div>
        ))}
      </div>

      <label className={`${LABEL} mt-3 block`}>
        Copy into
        <div className="mt-1 flex gap-2">
          <select
            className={FIELD}
            data-testid="mirror-destination"
            onChange={(input) =>
              setDraft({
                ...draft,
                destination: destinations.find((option) => option.key === input.target.value)?.ref,
              })
            }
            value={destinationKnown ? destinationKey : ''}
          >
            <option value="">Choose a calendar…</option>
            {!destinationKnown && draft.destination !== undefined ? (
              <option value={destinationKey}>
                {refLabel(draft.destination)} (not on this device)
              </option>
            ) : null}
            {destinations.map((option) => (
              <option key={option.key} value={option.key}>
                {option.group} · {option.label}
              </option>
            ))}
          </select>
          <button
            className={`${BUTTON} shrink-0`}
            data-testid="mirror-new-calendar"
            onClick={() => setCreating(true)}
            type="button"
          >
            New calendar…
          </button>
        </div>
      </label>
      <p className="mt-1 text-xs text-ink-secondary">{MIRROR_COPY.dedicated}</p>
      {preview !== null && preview.otherEvents > 0 ? (
        <p
          className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800"
          data-testid="mirror-shared-warning"
        >
          This calendar already holds {preview.otherEvents} other{' '}
          {preview.otherEvents === 1 ? 'event' : 'events'}. Solunivo will only ever change its own
          copies, but a calendar made for this mirror keeps them apart — and is the one you share.
        </p>
      ) : null}

      <p className={`${LABEL} mt-3`}>What others see</p>
      <div className="mt-1 grid grid-cols-3 gap-2" role="radiogroup">
        {MIRROR_PRESET_ORDER.map((id: MirrorPreset) => (
          <button
            aria-checked={preset === id}
            className={`rounded-lg border p-2 text-left ${
              preset === id ? 'border-primary bg-selection' : 'border-hairline bg-surface'
            }`}
            data-testid={`mirror-preset-${id}`}
            key={id}
            onClick={() => setDraft(withMirrorPreset(draft, id))}
            role="radio"
            type="button"
          >
            <span className="block text-sm font-medium">{MIRROR_PRESET_COPY[id].title}</span>
            <span className="block text-xs text-ink-secondary">
              {MIRROR_PRESET_COPY[id].description}
            </span>
          </button>
        ))}
      </div>

      <button
        className="mt-2 text-xs text-primary hover:underline"
        data-testid="mirror-advanced"
        onClick={() => setAdvanced(!advanced)}
        type="button"
      >
        {advanced ? 'Hide advanced' : 'Advanced…'}
      </button>
      {advanced ? (
        <div className="mt-2 grid grid-cols-2 gap-3 rounded-lg border border-hairline bg-surface p-3 text-sm">
          <div>
            <p className={LABEL}>Fields</p>
            {(['title', 'location', 'description'] as const).map((field) => (
              <label className="mt-1 flex items-center gap-1.5" key={field}>
                <input
                  checked={draft.fields[field]}
                  data-testid={`mirror-field-${field}`}
                  onChange={(input) =>
                    setDraft({
                      ...draft,
                      fields: { ...draft.fields, [field]: input.target.checked },
                    })
                  }
                  type="checkbox"
                />
                {field === 'title'
                  ? 'Title'
                  : field === 'location'
                    ? 'Location'
                    : 'Description and meeting link'}
              </label>
            ))}
            <label className={`${LABEL} mt-2 block`}>
              Busy label
              <input
                className={`${FIELD} mt-1`}
                data-testid="mirror-busy-label"
                onChange={(input) => setDraft({ ...draft, busyLabel: input.target.value })}
                value={draft.busyLabel}
              />
            </label>
            <label className={`${LABEL} mt-2 block`}>
              Months ahead
              <input
                className={`${FIELD} mt-1`}
                data-testid="mirror-months"
                max={MIRROR_MAX_MONTHS}
                min={1}
                onChange={(input) =>
                  setDraft({
                    ...draft,
                    monthsAhead: Math.min(
                      MIRROR_MAX_MONTHS,
                      Math.max(1, Math.round(Number(input.target.value) || 1)),
                    ),
                  })
                }
                type="number"
                value={draft.monthsAhead}
              />
            </label>
          </div>
          <div>
            <p className={LABEL}>Leave out</p>
            {(
              [
                ['declined', 'Events I declined'],
                ['free', 'Events marked free'],
                ['allDay', 'All-day events'],
              ] as const
            ).map(([filter, label]) => (
              <label className="mt-1 flex items-center gap-1.5" key={filter}>
                <input
                  checked={draft.filters[filter] === 'skip'}
                  data-testid={`mirror-filter-${filter}`}
                  onChange={(input) =>
                    setDraft({
                      ...draft,
                      filters: {
                        ...draft.filters,
                        [filter]: input.target.checked ? 'skip' : 'copy',
                      },
                    })
                  }
                  type="checkbox"
                />
                {label}
              </label>
            ))}
            <label className={`${LABEL} mt-2 block`}>
              Private events
              <select
                className={`${FIELD} mt-1`}
                data-testid="mirror-filter-private"
                onChange={(input) =>
                  setDraft({
                    ...draft,
                    filters: {
                      ...draft.filters,
                      private: input.target.value === 'skip' ? 'skip' : 'busy',
                    },
                  })
                }
                value={draft.filters.private}
              >
                <option value="busy">Copy as the busy label, time only</option>
                <option value="skip">Leave out</option>
              </select>
            </label>
          </div>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-ink-secondary">{MIRROR_COPY.window(draft.monthsAhead)}</p>

      {preview !== null ? (
        <div
          className="mt-3 rounded-lg border border-hairline bg-surface p-2 text-xs"
          data-testid="mirror-preview"
        >
          {preview.blocked ? (
            <p className="text-amber-800">
              Cannot preview yet: {preview.blocked.reason}
              {preview.blocked.detail ? ` (${preview.blocked.detail})` : ''}.
            </p>
          ) : (
            <>
              <p className="text-ink-secondary">
                {preview.copies} {preview.copies === 1 ? 'event' : 'events'} would be copied.
                {preview.samples.length > 0 ? ' Others see, for example:' : ''}
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {preview.samples.map((sample, index) => (
                  <li className="text-ink" key={index}>
                    <span className="font-medium">{sample.title}</span>
                    {sample.location ? ` · ${sample.location}` : ''}
                    <span className="text-ink-secondary">
                      {' '}
                      · {sampleTime(sample, draft.timeZone)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        {issue ? <span className="flex-1 text-xs text-ink-secondary">{issue}</span> : null}
        <button className={BUTTON} onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className={PRIMARY}
          data-testid="mirror-save"
          disabled={issue !== undefined || saving}
          onClick={() => void save()}
          type="button"
        >
          Save
        </button>
      </div>
      {creating ? (
        <NewCalendarDialog
          onClose={() => setCreating(false)}
          onCreated={(ref) => {
            setCreating(false);
            setDraft({ ...draft, destination: ref });
          }}
        />
      ) : null}
    </div>
  );
}

function DeleteDialog({ onClose, view }: { onClose: () => void; view: MirrorView }) {
  const mutations = useBackendMutations();
  const [removeCopies, setRemoveCopies] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    try {
      await mutations.deleteMirror({ id: view.definition.id, removeCopies });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  return (
    <Dialog label="Delete mirror" onClose={onClose} panelClassName="w-96 rounded-xl bg-surface p-4">
      <h3 className="font-medium">Delete “{view.definition.name}”?</h3>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          checked={removeCopies}
          className="mt-0.5"
          data-testid="mirror-remove-copies"
          onChange={(input) => setRemoveCopies(input.target.checked)}
          type="checkbox"
        />
        <span>
          Also remove its copies from {refLabel(view.definition.destination)}.
          <span className="block text-xs text-ink-secondary">
            If another device still runs this mirror, it will copy them again — delete it there too,
            or import the settings after.
          </span>
        </span>
      </label>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button className={BUTTON} onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className={PRIMARY}
          data-testid="mirror-delete-confirm"
          disabled={busy}
          onClick={() => void remove()}
          type="button"
        >
          Delete
        </button>
      </div>
    </Dialog>
  );
}

export function MirrorsSection() {
  const mirrors = useMirrors();
  const timeZone = useTimeZoneSettings()?.primary ?? Temporal.Now.timeZoneId();
  const [editing, setEditing] = useState<MirrorDraft | null>(null);
  const [deleting, setDeleting] = useState<MirrorView | null>(null);

  return (
    <section className="rounded-xl border border-hairline bg-surface p-4" data-testid="mirrors">
      <h2 className="font-medium">Calendar mirrors</h2>
      <p className="mt-1 text-sm text-ink-secondary">{MIRROR_COPY.intro}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {mirrors.map((view) => (
          <MirrorRow
            key={view.definition.id}
            onDelete={() => setDeleting(view)}
            onEdit={() => setEditing(draftOf(view.definition))}
            view={view}
          />
        ))}
      </ul>
      {editing ? (
        <MirrorEditor
          initial={editing}
          key={editing.id}
          mirrors={mirrors}
          onClose={() => setEditing(null)}
        />
      ) : (
        <button
          className={`${BUTTON} mt-3`}
          data-testid="mirror-add"
          onClick={() => setEditing(newMirrorDraft(timeZone))}
          type="button"
        >
          Add mirror…
        </button>
      )}
      <div className="mt-4 flex flex-col gap-1 text-xs text-ink-secondary">
        <p>{MIRROR_COPY.hidden}</p>
        <p>{MIRROR_COPY.freshness}</p>
        <p>{MIRROR_COPY.devices}</p>
        <p>{MIRROR_COPY.appleMarker}</p>
      </div>
      {deleting ? <DeleteDialog onClose={() => setDeleting(null)} view={deleting} /> : null}
    </section>
  );
}
