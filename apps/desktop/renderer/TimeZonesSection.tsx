import { useBackendMutations, useSettingsEditor, useTimeZoneSettings } from '@calendar/app-state';
import {
  DEVICE_ONLY_SETTING_COPY,
  MAX_TIME_ZONES,
  Temporal,
  withPrimary,
  withZoneAdded,
  withZoneRemoved,
  zoneCity,
  zoneSlug,
} from '@calendar/core';
import { useState } from 'react';
import { TimeZonePicker } from './TimeZonePicker.tsx';

/**
 * The zones this device draws: the primary one is what the grid, "today"
 * and the editors use; the others annotate the hour gutter, tall event
 * blocks and the editor. Every change sends the whole struct through the
 * core editors so `primary` and `zones` never drift apart.
 */
export function TimeZonesSection() {
  const { setTimeZoneSettings } = useBackendMutations();
  const [settings, persist] = useSettingsEditor(useTimeZoneSettings(), setTimeZoneSettings);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!settings) {
    return null;
  }
  const deviceZone = Temporal.Now.timeZoneId();
  const full = settings.zones.length >= MAX_TIME_ZONES;
  const save = (next: typeof settings) =>
    void persist(next).then(
      () => setNotice(null),
      (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
    );

  return (
    <section className="rounded-popover bg-surface-subtle p-4" data-testid="time-zones">
      <h2 className="font-medium">Time zones</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        The calendar is drawn in the primary zone; the others appear under each hour and on events.
      </p>
      <ul className="mt-3 flex flex-col gap-1">
        {settings.zones.map((zone) => {
          const primary = zone === settings.primary;
          const city = zoneCity(zone);
          return (
            <li
              className="flex items-center gap-2 text-sm"
              data-primary={primary ? 'true' : undefined}
              data-testid={`time-zone-row-${zoneSlug(zone)}`}
              key={zone}
            >
              <span className="font-medium">{city}</span>
              <span className="text-xs text-ink-secondary">
                {zone}
                {zone === deviceZone ? ' (this device)' : ''}
              </span>
              <span className="flex-1" />
              {primary ? (
                <span className="rounded-full bg-fill px-2 py-0.5 text-xs text-ink-secondary">
                  Primary
                </span>
              ) : (
                <button
                  aria-label={`Make ${city} primary`}
                  className="text-xs text-primary hover:underline"
                  onClick={() => save(withPrimary(settings, zone))}
                  type="button"
                >
                  Make primary
                </button>
              )}
              {settings.zones.length > 1 ? (
                <button
                  aria-label={`Remove ${city}`}
                  className="text-xs text-danger hover:underline"
                  onClick={() => save(withZoneRemoved(settings, zone))}
                  type="button"
                >
                  Remove
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {picking ? (
        <TimeZonePicker
          exclude={settings.zones}
          onCancel={() => setPicking(false)}
          onPick={(zone) => {
            setPicking(false);
            save(withZoneAdded(settings, zone));
          }}
        />
      ) : (
        <button
          aria-label="Add time zone"
          className="mt-3 text-sm text-primary hover:underline disabled:text-ink-secondary disabled:no-underline"
          disabled={full}
          onClick={() => setPicking(true)}
          title={full ? `Up to ${MAX_TIME_ZONES} time zones.` : undefined}
          type="button"
        >
          Add time zone
        </button>
      )}
      {notice ? (
        <p className="mt-3 text-sm text-warning" data-testid="time-zones-notice" role="status">
          {notice}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-ink-secondary" data-testid="time-zones-device-only">
        {DEVICE_ONLY_SETTING_COPY}
      </p>
    </section>
  );
}
