import {
  definitionOf,
  googleAccountsForNewCalendar,
  hasSource,
  type MirrorDraft,
  mirrorDestinationOptions,
  mirrorDraftIssue,
  mirrorSourceOptions,
  refSlug,
  useAccounts,
  useBackendMutations,
  useCalendars,
  useTaskLists,
  withSourceToggled,
} from '@calendar/app-state';
import {
  MIRROR_COPY,
  MIRROR_MAX_MONTHS,
  MIRROR_PRESET_COPY,
  MIRROR_PRESET_ORDER,
  type MirrorPreset,
  mirrorPresetOf,
  type MirrorPreview,
  type MirrorView,
  mirrorRefKey,
  Temporal,
  withMirrorPreset,
} from '@calendar/core';
import { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { TaskCheck } from '../TaskCheck.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';

const zoned = (ms: number, timeZone: string): Temporal.ZonedDateTime =>
  Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone);
const clock = (at: Temporal.ZonedDateTime): string =>
  at.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

const sampleTime = (sample: MirrorPreview['samples'][number], timeZone: string): string => {
  if (sample.allDay) {
    const day = Temporal.PlainDate.from(sample.startDate ?? '1970-01-01');
    return `${day.toLocaleString('en-US', { day: 'numeric', month: 'short', weekday: 'short' })}, all day`;
  }
  const start = zoned(sample.startUtc, timeZone);
  const day = start.toLocaleString('en-US', { day: 'numeric', month: 'short', weekday: 'short' });
  return `${day}, ${clock(start)}–${clock(zoned(sample.endUtc, timeZone))}`;
};

function Check({
  checked,
  label,
  onToggle,
  testID,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
  testID: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onToggle}
      style={styles.check}
      testID={testID}
    >
      {({ pressed }) => (
        <>
          <TaskCheck checked={checked} pressed={pressed} size="agenda" />
          <Text style={styles.checkLabel}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

/**
 * A mirror's editor: a page sheet over the Mirrors pages, which keep taps
 * alive with keyboardShouldPersistTaps (SettingsPage) — this Modal is
 * their child in the React tree, so without it the first tap on a row
 * would be eaten. The choices and checks come from the shared editor
 * model; only the controls are this platform's.
 */
export function MirrorEditSheet({
  initial,
  mirrors,
  onClose,
}: {
  initial: MirrorDraft;
  mirrors: ReadonlyArray<MirrorView>;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const mutations = useBackendMutations();
  const accounts = useAccounts();
  const calendars = useCalendars();
  const taskLists = useTaskLists();
  const [draft, setDraft] = useState(initial);
  const [advanced, setAdvanced] = useState(mirrorPresetOf(initial) === 'custom');
  const [previewed, setPreviewed] = useState<{ key: string; result: MirrorPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sources = mirrorSourceOptions({ accounts, calendars, taskLists });
  const destinations = mirrorDestinationOptions({ accounts, calendars, draft, mirrors });
  const issue = mirrorDraftIssue(draft);
  const preset = mirrorPresetOf(draft);
  const destinationKey = draft.destination === undefined ? '' : mirrorRefKey(draft.destination);

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
    setBusy(true);
    try {
      await mutations.saveMirror({ definition });
      onClose();
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  };

  const createMirrorCalendar = (
    target: Parameters<typeof mutations.createMirrorCalendar>[0]['target'],
  ) =>
    void mutations.createMirrorCalendar({ target }).then(
      (ref) => setDraft((current) => ({ ...current, destination: ref })),
      (error: unknown) => setError(String(error)),
    );

  const createCalendar = () => {
    const googleAccounts = googleAccountsForNewCalendar(accounts);
    Alert.prompt('New calendar', 'A calendar of its own for the copies.', (title) => {
      const name = title.trim();
      if (name === '') {
        return;
      }
      Alert.alert('Where?', undefined, [
        ...googleAccounts.map((account) => ({
          onPress: () =>
            createMirrorCalendar({ accountId: account.id, kind: 'google', title: name }),
          text: `Google · ${account.email}`,
        })),
        { onPress: () => createMirrorCalendar({ kind: 'apple', title: name }), text: 'iCloud' },
        { style: 'cancel' as const, text: 'Cancel' },
      ]);
    });
  };

  const groups = [...new Set(sources.map((option) => option.group))];

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <SafeAreaView style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={onClose}
            testID="mirror-cancel"
          >
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.link}>
              Cancel
            </Text>
          </Pressable>
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.sheetTitle}>
            {initial.name === '' ? 'New mirror' : 'Edit mirror'}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={issue !== undefined || busy}
            hitSlop={8}
            onPress={() => void save()}
            testID="mirror-save"
          >
            <Text
              maxFontSizeMultiplier={BOX_FONT_SCALE}
              style={[styles.link, (issue !== undefined || busy) && styles.disabled]}
            >
              Save
            </Text>
          </Pressable>
        </View>
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.content}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.label}>Name</Text>
          <TextInput
            onChangeText={(name) => setDraft({ ...draft, name })}
            placeholder="Family calendar"
            placeholderTextColor={colors['text-secondary']}
            style={styles.input}
            testID="mirror-name"
            value={draft.name}
          />

          <Text style={styles.label}>Copy from</Text>
          {groups.map((group) => (
            <View key={group}>
              <Text style={styles.meta}>{group}</Text>
              {sources
                .filter((option) => option.group === group)
                .map((option) => (
                  <Check
                    checked={hasSource(draft, option.ref)}
                    key={option.key}
                    label={option.label}
                    onToggle={() => setDraft(withSourceToggled(draft, option.ref))}
                    testID={`mirror-source-${refSlug(option.key)}`}
                  />
                ))}
            </View>
          ))}

          <Text style={styles.label}>Copy into</Text>
          <Text style={styles.meta}>{MIRROR_COPY.dedicated}</Text>
          {destinations.map((option) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: option.key === destinationKey }}
              key={option.key}
              onPress={() => setDraft({ ...draft, destination: option.ref })}
              style={[styles.option, option.key === destinationKey && styles.optionSelected]}
              testID={`mirror-destination-${refSlug(option.key)}`}
            >
              <Text style={styles.optionTitle}>{option.label}</Text>
              <Text style={styles.meta}>{option.group}</Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={createCalendar}
            style={styles.addRow}
            testID="mirror-new-calendar"
          >
            <Text style={styles.link}>New calendar…</Text>
          </Pressable>
          {preview !== null && preview.otherEvents > 0 ? (
            <Text style={styles.warning} testID="mirror-shared-warning">
              This calendar already holds {preview.otherEvents} other{' '}
              {preview.otherEvents === 1 ? 'event' : 'events'}. Solunivo only changes its own
              copies, but a calendar made for this mirror keeps them apart — and is the one you
              share.
            </Text>
          ) : null}

          <Text style={styles.label}>What others see</Text>
          {MIRROR_PRESET_ORDER.map((id: MirrorPreset) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: preset === id }}
              key={id}
              onPress={() => setDraft(withMirrorPreset(draft, id))}
              style={[styles.option, preset === id && styles.optionSelected]}
              testID={`mirror-preset-${id}`}
            >
              <Text style={styles.optionTitle}>{MIRROR_PRESET_COPY[id].title}</Text>
              <Text style={styles.meta}>{MIRROR_PRESET_COPY[id].description}</Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={() => setAdvanced(!advanced)}
            style={styles.addRow}
            testID="mirror-advanced"
          >
            <Text style={styles.link}>{advanced ? 'Hide advanced' : 'Advanced…'}</Text>
          </Pressable>
          {advanced ? (
            <View>
              <Text style={styles.label}>Fields</Text>
              {(
                [
                  ['title', 'Title'],
                  ['location', 'Location'],
                  ['description', 'Description and meeting link'],
                ] as const
              ).map(([field, label]) => (
                <Check
                  checked={draft.fields[field]}
                  key={field}
                  label={label}
                  onToggle={() =>
                    setDraft({
                      ...draft,
                      fields: { ...draft.fields, [field]: !draft.fields[field] },
                    })
                  }
                  testID={`mirror-field-${field}`}
                />
              ))}
              <Text style={styles.label}>Busy label</Text>
              <TextInput
                onChangeText={(busyLabel) => setDraft({ ...draft, busyLabel })}
                style={styles.input}
                testID="mirror-busy-label"
                value={draft.busyLabel}
              />
              <Text style={styles.label}>Months ahead (1–{MIRROR_MAX_MONTHS})</Text>
              <TextInput
                keyboardType="number-pad"
                onChangeText={(text) =>
                  setDraft({
                    ...draft,
                    monthsAhead: Math.min(
                      MIRROR_MAX_MONTHS,
                      Math.max(1, Math.round(Number(text) || 1)),
                    ),
                  })
                }
                style={styles.input}
                testID="mirror-months"
                value={String(draft.monthsAhead)}
              />
              <Text style={styles.label}>Leave out</Text>
              {(
                [
                  ['declined', 'Events I declined'],
                  ['free', 'Events marked free'],
                  ['allDay', 'All-day events'],
                ] as const
              ).map(([filter, label]) => (
                <Check
                  checked={draft.filters[filter] === 'skip'}
                  key={filter}
                  label={label}
                  onToggle={() =>
                    setDraft({
                      ...draft,
                      filters: {
                        ...draft.filters,
                        [filter]: draft.filters[filter] === 'skip' ? 'copy' : 'skip',
                      },
                    })
                  }
                  testID={`mirror-filter-${filter}`}
                />
              ))}
              <Check
                checked={draft.filters.private === 'skip'}
                label="Private events (otherwise copied as the busy label, time only)"
                onToggle={() =>
                  setDraft({
                    ...draft,
                    filters: {
                      ...draft.filters,
                      private: draft.filters.private === 'skip' ? 'busy' : 'skip',
                    },
                  })
                }
                testID="mirror-filter-private"
              />
            </View>
          ) : null}

          <Text style={styles.meta}>{MIRROR_COPY.window(draft.monthsAhead)}</Text>
          {preview !== null ? (
            <View style={styles.preview} testID="mirror-preview">
              {preview.blocked ? (
                <Text style={styles.warning}>
                  Cannot preview yet: {preview.blocked.reason}
                  {preview.blocked.detail ? ` (${preview.blocked.detail})` : ''}.
                </Text>
              ) : (
                <>
                  <Text style={styles.meta}>
                    {preview.copies} {preview.copies === 1 ? 'event' : 'events'} would be copied.
                    {preview.samples.length > 0 ? ' Others see, for example:' : ''}
                  </Text>
                  {preview.samples.map((sample, index) => (
                    <Text key={index} style={styles.sample}>
                      {sample.title}
                      {sample.location ? ` · ${sample.location}` : ''} ·{' '}
                      {sampleTime(sample, draft.timeZone)}
                    </Text>
                  ))}
                </>
              )}
            </View>
          ) : null}
          {issue ? <Text style={styles.meta}>{issue}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Text style={styles.footer}>{MIRROR_COPY.sharing}</Text>
          <Text style={styles.footer}>{MIRROR_COPY.appleMarker}</Text>
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
    check: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      paddingVertical: 6,
    },
    checkLabel: {
      color: colors.text,
      flex: 1,
      fontSize: 15,
    },
    content: {
      gap: 4,
      padding: 16,
      paddingBottom: 48,
    },
    disabled: {
      opacity: 0.4,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      marginTop: 8,
    },
    footer: {
      color: colors['text-secondary'],
      fontSize: 12,
      marginTop: 8,
    },
    input: {
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.text,
      fontSize: 15,
      marginTop: 4,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    label: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      marginTop: 14,
      textTransform: 'uppercase',
    },
    link: {
      color: colors.primary,
      fontSize: 14,
      fontWeight: '600',
    },
    meta: {
      color: colors['text-secondary'],
      fontSize: 12,
      marginTop: 2,
    },
    option: {
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: 6,
      padding: 10,
    },
    optionSelected: {
      backgroundColor: colors.selection,
      borderColor: colors.primary,
    },
    optionTitle: {
      color: colors.text,
      fontSize: 15,
    },
    preview: {
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: 10,
      padding: 10,
    },
    sample: {
      color: colors.text,
      fontSize: 13,
      marginTop: 2,
    },
    sheet: {
      backgroundColor: colors.surface,
      flex: 1,
    },
    sheetHeader: {
      alignItems: 'center',
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    sheetTitle: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '600',
    },
    warning: {
      backgroundColor: colors.warning,
      borderRadius: 8,
      color: colors['on-warning'],
      fontSize: 12,
      marginTop: 8,
      padding: 8,
    },
  });
