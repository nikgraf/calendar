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
import { useTheme } from '../theme.ts';
import {
  ActionRow,
  Footer,
  LeadingSpace,
  LeadingSymbol,
  Section,
  SettingsPage,
  SwipeRow,
  Row,
  Tag,
} from './GroupedList.tsx';
import { TimeZonePickerSheet } from './TimeZonePickerSheet.tsx';

/**
 * Time Zones: the zones this iPhone draws. The primary zone (the row
 * tagged Primary) is what the grid, "today" and the editors use; the
 * others annotate the hour gutter, tall event blocks and the editor. The
 * first row is the iPhone's own zone, resolved against the OS so it moves
 * when the iPhone travels; it is never removed. Every change sends the
 * whole struct through the core editors so `primary` and `zones` never
 * drift apart.
 */
export function TimeZonesPage() {
  const { colors } = useTheme();
  const mutations = useBackendMutations();
  const [settings, persist] = useSettingsEditor(
    useTimeZoneSettings(),
    mutations.setTimeZoneSettings,
  );
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const deviceZone = useDeviceZone();
  const full = settings !== null && settings.zones.length >= MAX_TIME_ZONES;
  const save = (next: NonNullable<typeof settings>) =>
    void persist(next).then(
      () => setNotice(null),
      (error: unknown) => setNotice(String(error)),
    );

  return (
    <SettingsPage testID="settings-page-time-zones">
      {settings ? (
        <Section
          footer={
            <>
              <Footer>
                The calendar is drawn in the primary zone; tap another zone to make it primary. The
                others appear under each hour and on events. The first zone is this iPhone&apos;s
                own and follows it when you travel; swipe left on any other to remove it.
              </Footer>
              {notice ? (
                <Footer testID="time-zones-notice" tone="danger">
                  {notice}
                </Footer>
              ) : null}
              <Footer testID="time-zones-device-only">{DEVICE_ONLY_SETTING_COPY}</Footer>
            </>
          }
          testID="time-zones"
        >
          {settings.zones.map((zone) => {
            const primary = zone === settings.primary;
            const device = isDeviceZone(zone);
            const slug = device ? 'device' : zoneSlug(zone);
            const row = {
              accessibilityRole: 'radio' as const,
              accessibilityState: { selected: primary },
              accessory: primary ? <Tag label="Primary" testID="time-zone-primary-tag" /> : null,
              leading: device ? (
                <LeadingSymbol color={colors.primary} name="location.fill" />
              ) : (
                <LeadingSpace />
              ),
              onPress: () => {
                if (!primary) {
                  save(withPrimary(settings, zone));
                }
              },
              subtitle: device ? 'Current time zone' : zone,
              testID: `time-zone-row-${slug}${primary ? '-primary' : ''}`,
              title: zoneCity(device ? deviceZone : zone),
            };
            return device ? (
              <Row {...row} key={zone} />
            ) : (
              <SwipeRow
                {...row}
                action={() => save(withZoneRemoved(settings, zone))}
                actionLabel="Remove"
                actionTestID={`time-zone-remove-${slug}`}
                key={zone}
              />
            );
          })}
          <ActionRow
            disabled={full}
            leading={<LeadingSpace />}
            onPress={() => setPicking(true)}
            testID="time-zone-add"
            title={full ? `Up to ${String(MAX_TIME_ZONES)} Time Zones` : 'Add Time Zone…'}
          />
        </Section>
      ) : null}

      {settings ? (
        <TimeZonePickerSheet
          exclude={settings.zones}
          onClose={() => setPicking(false)}
          onPick={(zone) => {
            setPicking(false);
            save(withZoneAdded(settings, zone));
          }}
          visible={picking}
        />
      ) : null}
    </SettingsPage>
  );
}
