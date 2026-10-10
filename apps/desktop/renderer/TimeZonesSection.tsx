import {
  useBackendMutations,
  useDeviceZone,
  useSettingsEditor,
  useTimeZoneSettings,
} from '@calendar/app-state';
import {
  DEVICE_ONLY_SETTING_COPY,
  isDeviceZone,
  MAX_TIME_ZONES,
  withPrimary,
  withZoneAdded,
  withZoneRemoved,
  zoneCity,
  zoneSlug,
} from '@calendar/core';
import { useState } from 'react';
import { TimeZonePicker } from './TimeZonePicker.tsx';
import { LocationIcon } from './ui/icons.tsx';

/**
 * The zones this device draws: the primary one is what the grid, "today"
 * and the editors use; the others annotate the hour gutter, tall event
 * blocks and the editor. The first row is the Mac's own zone, resolved
 * against the OS so it moves when the Mac travels; it is never removed.
 * Every change sends the whole struct through the core editors so
 * `primary` and `zones` never drift apart.
 */
export function TimeZonesSection() {
  const { setTimeZoneSettings } = useBackendMutations();
  const [settings, persist] = useSettingsEditor(useTimeZoneSettings(), setTimeZoneSettings);
  const deviceZone = useDeviceZone();
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!settings) {
    return null;
  }
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
        The first zone is this Mac&apos;s own and follows it when you travel.
      </p>
      <ul className="mt-3 flex flex-col gap-1">
        {settings.zones.map((zone) => {
          const primary = zone === settings.primary;
          const device = isDeviceZone(zone);
          const city = zoneCity(device ? deviceZone : zone);
          const name = device ? "this Mac's zone" : city;
          return (
            <li
              className="flex items-center gap-2 text-sm"
              data-primary={primary ? 'true' : undefined}
              data-testid={`time-zone-row-${device ? 'device' : zoneSlug(zone)}`}
              key={zone}
            >
              {device ? (
                <LocationIcon className="shrink-0 text-primary" size={14} />
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              <span className="font-medium">{city}</span>
              <span className="text-xs text-ink-secondary">
                {device ? 'Follows this Mac' : zone}
              </span>
              <span className="flex-1" />
              {primary ? (
                <span className="rounded-full bg-fill px-2 py-0.5 text-xs text-ink-secondary">
                  Primary
                </span>
              ) : (
                <button
                  aria-label={`Make ${name} primary`}
                  className="text-xs text-primary hover:underline"
                  onClick={() => save(withPrimary(settings, zone))}
                  type="button"
                >
                  Make primary
                </button>
              )}
              {device ? null : (
                <button
                  aria-label={`Remove ${city}`}
                  className="text-xs text-danger hover:underline"
                  onClick={() => save(withZoneRemoved(settings, zone))}
                  type="button"
                >
                  Remove
                </button>
              )}
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
