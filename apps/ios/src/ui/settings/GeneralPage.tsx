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
  Checkmark,
  Footer,
  LeadingSpace,
  LeadingSymbol,
  Section,
  SettingsPage,
  SwipeRow,
  Row,
} from './GroupedList.tsx';
import { TimeZonePickerSheet } from './TimeZonePickerSheet.tsx';

/**
 * General: the time zones this iPhone draws and the location cache. The
 * primary zone (the checked row) is what the grid, "today" and the editors
 * use; the others annotate the hour gutter, tall event blocks and the
 * editor. The first row is the iPhone's own zone, resolved against the OS
 * so it moves when the iPhone travels; it is never removed. Every change
 * sends the whole struct through the core editors so `primary` and
 * `zones` never drift apart.
 */
export function GeneralPage() {
  const { colors } = useTheme();
  const mutations = useBackendMutations();
  const [settings, persist] = useSettingsEditor(
    useTimeZoneSettings(),
    mutations.setTimeZoneSettings,
  );
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cache, setCache] = useState<'busy' | 'cleared' | 'idle'>('idle');

  const clearCache = async () => {
    setCache('busy');
    try {
      await mutations.clearLocationCache(undefined);
      setCache('cleared');
    } catch {
      setCache('idle');
    }
  };

  const deviceZone = useDeviceZone();
  const full = settings !== null && settings.zones.length >= MAX_TIME_ZONES;
  const save = (next: NonNullable<typeof settings>) =>
    void persist(next).then(
      () => setNotice(null),
      (error: unknown) => setNotice(String(error)),
    );

  return (
    <SettingsPage testID="settings-page-general">
      {settings ? (
        <Section
          footer={
            <>
              <Footer>
                The calendar is drawn in the checked zone; tap another to switch. The others appear
                under each hour and on events. The first zone is this iPhone&apos;s own and follows
                it when you travel; swipe left on any other to remove it.
              </Footer>
              {notice ? (
                <Footer testID="time-zones-notice" tone="danger">
                  {notice}
                </Footer>
              ) : null}
              <Footer testID="time-zones-device-only">{DEVICE_ONLY_SETTING_COPY}</Footer>
            </>
          }
          header="Time Zones"
          testID="time-zones"
        >
          {settings.zones.map((zone) => {
            const primary = zone === settings.primary;
            const device = isDeviceZone(zone);
            const slug = device ? 'device' : zoneSlug(zone);
            const row = {
              accessibilityRole: 'radio' as const,
              accessibilityState: { selected: primary },
              accessory: <Checkmark checked={primary} />,
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
              subtitle: device ? 'Follows this iPhone when you travel' : zone,
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

      <Section
        footer={
          <>
            <Footer>
              Event locations are looked up on this iPhone with Apple Maps and remembered so the
              editor map opens instantly. Remembered places refresh every two weeks.
            </Footer>
            {cache === 'cleared' ? (
              <Footer testID="location-cache-cleared">
                Cleared — places are looked up again the next time an event opens.
              </Footer>
            ) : null}
          </>
        }
        header="Locations"
        testID="locations-section"
      >
        <ActionRow
          disabled={cache === 'busy'}
          onPress={() => void clearCache()}
          testID="clear-location-cache"
          title="Clear Location Cache"
        />
      </Section>

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
