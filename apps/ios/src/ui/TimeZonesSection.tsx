import { useBackendMutations, useSettingsEditor, useTimeZoneSettings } from '@calendar/app-state';
import {
  DEVICE_ONLY_SETTING_COPY,
  MAX_TIME_ZONES,
  searchTimeZones,
  Temporal,
  withPrimary,
  withZoneAdded,
  withZoneRemoved,
  zoneCity,
  zoneSlug,
} from '@calendar/core';
import { useState } from 'react';
import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSectionStyles } from './settingsShared.ts';
import { type ThemeColors, useStyles, useTheme } from './theme.ts';

/**
 * The zones this iPhone draws: the primary one is what the grid, "today"
 * and the editors use; the others annotate the hour gutter, tall event
 * blocks and the editor. Every change sends the whole struct through the
 * core editors so `primary` and `zones` never drift apart. Adding one
 * opens a searchable sheet over the catalog.
 */
export function TimeZonesSection() {
  const sectionStyles = useSectionStyles();
  const styles = useStyles(makeStyles);
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
      (error: unknown) => setNotice(String(error)),
    );

  return (
    <View style={sectionStyles.card} testID="time-zones">
      <Text style={sectionStyles.title}>Time zones</Text>
      <Text style={sectionStyles.meta}>
        The calendar is drawn in the primary zone; the others appear under each hour and on events.
      </Text>
      {settings.zones.map((zone) => {
        const primary = zone === settings.primary;
        const slug = zoneSlug(zone);
        return (
          <View
            key={zone}
            style={styles.row}
            testID={`time-zone-row-${slug}${primary ? '-primary' : ''}`}
          >
            <View style={styles.rowText}>
              <Text style={styles.city}>{zoneCity(zone)}</Text>
              <Text style={sectionStyles.meta}>
                {zone}
                {zone === deviceZone ? ' (this device)' : ''}
              </Text>
            </View>
            {primary ? (
              <Text style={styles.primaryBadge}>Primary</Text>
            ) : (
              <Pressable
                accessibilityLabel={`Make ${zoneCity(zone)} primary`}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => save(withPrimary(settings, zone))}
                testID={`time-zone-make-primary-${slug}`}
              >
                <Text style={styles.link}>Make primary</Text>
              </Pressable>
            )}
            {settings.zones.length > 1 ? (
              <Pressable
                accessibilityLabel={`Remove ${zoneCity(zone)}`}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => save(withZoneRemoved(settings, zone))}
                testID={`time-zone-remove-${slug}`}
              >
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: full }}
        disabled={full}
        onPress={() => setPicking(true)}
        style={styles.addRow}
        testID="time-zone-add"
      >
        <Text style={[styles.link, full && sectionStyles.busy]}>
          {full ? `Up to ${MAX_TIME_ZONES} time zones` : 'Add time zone'}
        </Text>
      </Pressable>
      {notice ? (
        <Text style={sectionStyles.action} testID="time-zones-notice">
          {notice}
        </Text>
      ) : null}
      <Text style={sectionStyles.meta} testID="time-zones-device-only">
        {DEVICE_ONLY_SETTING_COPY}
      </Text>
      <TimeZonePickerSheet
        exclude={settings.zones}
        onClose={() => setPicking(false)}
        onPick={(zone) => {
          setPicking(false);
          save(withZoneAdded(settings, zone));
        }}
        visible={picking}
      />
    </View>
  );
}

/**
 * A search box over the zone catalog; a tap on a row picks it. The rows
 * are plain pressables in a ScrollView that keeps taps alive with
 * keyboardShouldPersistTaps, like the edit form's invitee and location
 * fields. The settings sheet's own ScrollView needs the same flag: this
 * Modal is a child of it in the React tree, so the responder capture that
 * dismisses the keyboard runs there first (it ate the first row tap).
 */
function TimeZonePickerSheet({
  exclude,
  onClose,
  onPick,
  visible,
}: {
  exclude: ReadonlyArray<string>;
  onClose: () => void;
  onPick: (zone: string) => void;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const sectionStyles = useSectionStyles();
  const styles = useStyles(makeStyles);
  const [query, setQuery] = useState('');
  const matches = searchTimeZones(query, exclude);
  const close = () => {
    setQuery('');
    onClose();
  };
  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={close}
            testID="time-zone-cancel"
          >
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Text style={styles.sheetTitle}>Add time zone</Text>
          <View style={styles.sheetHeaderSpacer} />
        </View>
        <ScrollView
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          style={styles.list}
        >
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onChangeText={setQuery}
            placeholder="City or region"
            placeholderTextColor={colors['text-secondary']}
            style={styles.search}
            testID="time-zone-search"
            value={query}
          />
          {matches.map((match) => (
            <Pressable
              accessibilityRole="button"
              key={match.id}
              onPress={() => {
                setQuery('');
                onPick(match.id);
              }}
              style={styles.option}
              testID={`time-zone-option-${zoneSlug(match.id)}`}
            >
              <Text style={styles.city}>{match.city}</Text>
              <Text style={sectionStyles.meta}>{match.id}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    addRow: {
      marginTop: 10,
    },
    city: {
      color: colors.text,
      fontSize: 15,
    },
    link: {
      color: colors.primary,
      fontSize: 14,
      fontWeight: '600',
    },
    list: {
      flex: 1,
    },
    option: {
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    primaryBadge: {
      backgroundColor: colors.fill,
      borderRadius: 10,
      color: colors['text-secondary'],
      fontSize: 12,
      overflow: 'hidden',
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    remove: {
      color: colors.danger,
      fontSize: 14,
      fontWeight: '600',
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 12,
      marginTop: 10,
    },
    rowText: {
      flex: 1,
    },
    search: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      fontSize: 16,
      marginHorizontal: 16,
      marginVertical: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    sheet: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    sheetHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    sheetHeaderSpacer: {
      width: 48,
    },
    sheetTitle: {
      fontSize: 17,
      fontWeight: '700',
    },
  });
