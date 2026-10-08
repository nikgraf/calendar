import { makeFindSlots } from '@calendar/ai';
import {
  eventDraftFromPrefill,
  getLastUsedCalendarKey,
  rememberCalendar,
  taskParamsFromPrefill,
  useCalendars,
  useGuardedMutations,
  useModelAvailability,
  useQuickAddModel,
  useTaskLists,
  type QuickAddReview,
  type TaskEditorSeed,
} from '@calendar/app-state';
import { formatPlainTime, formatSlotLabel, isCalendarWritable, Temporal } from '@calendar/core';
import { useMemo } from 'react';
import {
  ActivityIndicator,
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { appleSpeech } from '../appleSpeech.ts';
import { backendClient } from '../backend.ts';
import { languageModel } from '../model.ts';
import type { EditSeed } from './EventEditSheet.tsx';
import { type ThemeColors, useStyles } from './theme.ts';

/** Foundation Models exist from iOS 26; below that there is nothing to say. */
const MODEL_MIN_IOS = 26;
/** `Platform.Version` is a string like "26.0" on iOS, a number elsewhere. */
const iosMajorVersion = (): number => Number.parseInt(String(Platform.Version), 10);

const UNAVAILABLE_NOTICE =
  'Quick add needs Apple Intelligence. Switch it on in Settings → Apple Intelligence & Siri; ' +
  'its models can take a while to download after that.';

/**
 * Apple Intelligence is switched on in Settings, which means leaving the
 * app: re-check on the way back so the field appears without a relaunch.
 * Model downloads finish out of process too.
 */
const onAppActive = (onActive: () => void): (() => void) => {
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      onActive();
    }
  });
  return () => subscription.remove();
};

const reviewLine = (review: QuickAddReview): string => {
  const day = Temporal.PlainDate.from(review.prefill.date).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  });
  if (review.kind === 'task') {
    return review.prefill.time ? `${day} · ${formatPlainTime(review.prefill.time)}` : day;
  }
  return review.prefill.isAllDay
    ? `${day} · all day`
    : `${day} · ${formatPlainTime(review.prefill.startTime)} – ${formatPlainTime(review.prefill.endTime)}`;
};

/**
 * The "+" sheet: a phrase, typed or dictated, becomes an event or a task
 * — held for a look first ("Understood as", with an Event/Task toggle),
 * then added as it stands or opened in the editor. Find a time lists free
 * slots. "New event" opens the empty editor without the model, which is
 * also what the e2e flows take. Nothing is written by the model itself.
 */
export function QuickAddSheet({
  focusedDate,
  onClose,
  onEditEvent,
  onEditTask,
  timeZone,
}: {
  /** The day being viewed: undated phrases and "New event" land on it, like the editor from a slot. */
  focusedDate: Temporal.PlainDate;
  onClose: () => void;
  onEditEvent: (seed: EditSeed) => void;
  onEditTask: (seed: TaskEditorSeed) => void;
  timeZone: string;
}) {
  const styles = useStyles(makeStyles);
  const { checking, retry, status } = useModelAvailability(languageModel, onAppActive);
  const findSlots = useMemo(
    () => makeFindSlots(languageModel, backendClient, timeZone),
    [timeZone],
  );
  const calendars = useCalendars();
  const taskLists = useTaskLists();
  const { createEvent, createTask } = useGuardedMutations();
  const {
    busy,
    confirmReview,
    dismissReview,
    error,
    found,
    mode,
    phrase,
    pickSlot,
    review,
    setMode,
    setPhrase,
    setReviewKind,
    startRecording,
    stopRecording,
    submit,
    voice,
    voiceAvailable,
  } = useQuickAddModel({
    fallbackDate: focusedDate.toString(),
    findSlots,
    model: languageModel,
    onPrefill: (prefill) =>
      onEditEvent({ initialDate: Temporal.PlainDate.from(prefill.date), prefill }),
    onTaskPrefill: (prefill) =>
      onEditTask({
        dated: true,
        initialDate: prefill.date,
        initialTime: prefill.time,
        title: prefill.title,
      }),
    reviewFirst: true,
    speech: appleSpeech,
    timeZone,
  });

  const writableCalendar = () => {
    const writable = calendars.filter(isCalendarWritable);
    const last = getLastUsedCalendarKey();
    return (
      writable.find((calendar) => `${calendar.accountId}:${calendar.id}` === last) ?? writable[0]
    );
  };
  const targetList = taskLists.find((list) => list.isVisible && !list.readOnly);

  /** "Add event" / "Add task": the item as understood, written without the editor. */
  const addNow = () => {
    if (!review) {
      return;
    }
    if (review.kind === 'event') {
      const calendar = writableCalendar();
      if (!calendar) {
        return;
      }
      rememberCalendar(`${calendar.accountId}:${calendar.id}`);
      void createEvent(
        eventDraftFromPrefill(
          review.prefill,
          { accountId: calendar.accountId, calendarId: calendar.id },
          timeZone,
        ),
      );
    } else {
      if (!targetList) {
        return;
      }
      void createTask(taskParamsFromPrefill(review.prefill, targetList));
    }
    dismissReview();
    onClose();
  };

  // A build without the framework, or an OS too old for it, gives the
  // user nothing to act on; otherwise say why the field is missing — the
  // silence is what made this hard to diagnose. "New event" stays either way.
  const unavailable = status !== null && status !== 'ready';
  const explain = unavailable && status !== 'missing-module' && iosMajorVersion() >= MODEL_MIN_IOS;

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <View style={styles.container} testID="quick-add-sheet">
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={onClose} testID="quick-add-cancel">
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>{mode === 'find' ? 'Find a time' : 'Quick add'}</Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* The marker renders once the availability check resolved, whatever it said. */}
          {status === null ? null : (
            <View testID="quick-add-state">
              {explain ? (
                <View style={styles.notice}>
                  <Text style={styles.noticeText}>{UNAVAILABLE_NOTICE}</Text>
                  <Pressable
                    accessibilityLabel="Check for the on-device model again"
                    accessibilityRole="button"
                    disabled={checking}
                    onPress={retry}
                    style={[styles.secondaryButton, checking && styles.disabled]}
                    testID="quick-add-recheck"
                  >
                    <Text style={styles.secondaryLabel}>Retry</Text>
                  </Pressable>
                </View>
              ) : null}
              {unavailable ? null : (
                <>
                  <View style={styles.modeRow}>
                    {(['add', 'find'] as const).map((option) => (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: mode === option }}
                        key={option}
                        onPress={() => setMode(option)}
                        style={[styles.modeChip, mode === option && styles.modeChipActive]}
                        testID={option === 'find' ? 'find-time-mode' : 'quick-add-mode'}
                      >
                        <Text style={[styles.modeLabel, mode === option && styles.modeLabelActive]}>
                          {option === 'add' ? 'Add' : 'Find time'}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={styles.row}>
                    <TextInput
                      accessibilityLabel={
                        mode === 'find' ? 'Describe the time you need' : 'Describe an event to add'
                      }
                      autoFocus
                      editable={!busy}
                      onChangeText={setPhrase}
                      onSubmitEditing={() => void submit()}
                      placeholder={
                        mode === 'find'
                          ? '90 min focus this week, mornings'
                          : 'Lunch with Sarah tomorrow at 1'
                      }
                      returnKeyType="go"
                      style={styles.input}
                      testID="quick-add-input"
                      value={phrase}
                    />
                    {voiceAvailable && !busy && voice !== 'transcribing' ? (
                      <Pressable
                        accessibilityLabel={
                          voice === 'recording' ? 'Stop dictating' : 'Dictate an event'
                        }
                        accessibilityRole="button"
                        disabled={voice === 'preparing'}
                        onPress={() =>
                          void (voice === 'recording' ? stopRecording() : startRecording())
                        }
                        style={[styles.mic, voice === 'recording' && styles.micRecording]}
                        testID="quick-add-mic"
                      >
                        <Text style={styles.micLabel}>{voice === 'recording' ? '■' : '🎙'}</Text>
                      </Pressable>
                    ) : null}
                    {busy || voice === 'transcribing' || voice === 'preparing' ? (
                      <ActivityIndicator style={styles.spinner} />
                    ) : (
                      <Pressable
                        accessibilityLabel="Add the described event"
                        accessibilityRole="button"
                        disabled={phrase.trim() === '' || voice === 'recording'}
                        onPress={() => void submit()}
                        style={[
                          styles.button,
                          (phrase.trim() === '' || voice === 'recording') && styles.disabled,
                        ]}
                        testID="quick-add-submit"
                      >
                        <Text style={styles.buttonLabel}>{mode === 'find' ? 'Find' : 'Add'}</Text>
                      </Pressable>
                    )}
                  </View>
                  {voice === 'preparing' ? (
                    <Text style={styles.hint}>Preparing dictation…</Text>
                  ) : voice === 'recording' ? (
                    <Text style={styles.hint}>Listening — tap ■ when finished.</Text>
                  ) : voice === 'transcribing' ? (
                    <Text style={styles.hint}>Transcribing…</Text>
                  ) : null}
                  {error ? <Text style={styles.error}>{error}</Text> : null}
                </>
              )}
            </View>
          )}

          {review ? (
            <View style={styles.card} testID="quick-add-review">
              <View style={styles.cardHeader}>
                <Text style={styles.cardEyebrow}>Understood as</Text>
                <View style={styles.modeRow}>
                  {(['event', 'task'] as const).map((kind) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: review.kind === kind }}
                      key={kind}
                      onPress={() => setReviewKind(kind)}
                      style={[styles.modeChip, review.kind === kind && styles.modeChipActive]}
                      testID={`quick-add-kind-${kind}`}
                    >
                      <Text
                        style={[styles.modeLabel, review.kind === kind && styles.modeLabelActive]}
                      >
                        {kind === 'event' ? 'Event' : 'Task'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <Text style={styles.cardTitle}>{review.prefill.title}</Text>
              <Text style={styles.cardMeta}>{reviewLine(review)}</Text>
              <Text style={styles.cardMeta}>
                {review.kind === 'event'
                  ? (writableCalendar()?.summary ?? 'No calendar')
                  : (targetList?.title ?? 'No task list')}
              </Text>
              <View style={styles.cardActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={confirmReview}
                  style={styles.secondaryButton}
                  testID="quick-add-edit"
                >
                  <Text style={styles.secondaryLabel}>Edit details</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={addNow}
                  style={styles.button}
                  testID="quick-add-confirm"
                >
                  <Text style={styles.buttonLabel}>
                    {review.kind === 'event' ? 'Add event' : 'Add task'}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {found ? (
            <View style={styles.card}>
              <Text style={styles.cardEyebrow}>Free slots</Text>
              <View style={styles.slotRow}>
                {found.slots.map((slot, index) => (
                  <Pressable
                    accessibilityRole="button"
                    key={`${slot.date}T${slot.startTime}`}
                    onPress={() => pickSlot(slot)}
                    style={styles.slotChip}
                    testID={`find-time-slot-${index}`}
                  >
                    <Text style={styles.slotLabel}>{formatSlotLabel(slot)}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={() => onEditEvent({ initialDate: focusedDate })}
            style={styles.newEvent}
            testID="quick-add-new-event"
          >
            <Text style={styles.newEventLabel}>New event</Text>
            <Text style={styles.newEventHint}>Open the empty editor</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    button: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    buttonLabel: {
      color: colors['on-primary'],
      fontSize: 15,
      fontWeight: '600',
    },
    cancel: {
      color: colors['text-secondary'],
      fontSize: 16,
    },
    card: {
      backgroundColor: colors['surface-subtle'],
      borderRadius: 12,
      gap: 6,
      padding: 14,
    },
    cardActions: {
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'flex-end',
      marginTop: 6,
    },
    cardEyebrow: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: '600',
    },
    cardHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    cardMeta: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
    cardTitle: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
    },
    container: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    content: {
      gap: 14,
      padding: 16,
      paddingBottom: 48,
    },
    disabled: {
      opacity: 0.4,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    headerSpacer: {
      width: 56,
    },
    hint: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    input: {
      backgroundColor: colors.fill,
      borderRadius: 10,
      color: colors.text,
      flex: 1,
      fontSize: 16,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    mic: {
      alignItems: 'center',
      backgroundColor: colors.fill,
      borderRadius: 10,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    micLabel: {
      fontSize: 16,
    },
    micRecording: {
      backgroundColor: colors['event-blush'],
    },
    modeChip: {
      borderRadius: 7,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    modeChipActive: {
      backgroundColor: colors.surface,
    },
    modeLabel: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontWeight: '500',
    },
    modeLabelActive: {
      color: colors.text,
      fontWeight: '600',
    },
    modeRow: {
      alignSelf: 'flex-start',
      backgroundColor: colors.fill,
      borderRadius: 9,
      flexDirection: 'row',
      padding: 2,
    },
    newEvent: {
      backgroundColor: colors.fill,
      borderRadius: 12,
      padding: 14,
    },
    newEventHint: {
      color: colors['text-secondary'],
      fontSize: 13,
      marginTop: 2,
    },
    newEventLabel: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '600',
    },
    notice: {
      backgroundColor: colors.fill,
      borderRadius: 12,
      gap: 10,
      padding: 14,
    },
    noticeText: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      marginTop: 10,
    },
    secondaryButton: {
      alignSelf: 'flex-start',
      backgroundColor: colors.fill,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    secondaryLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    slotChip: {
      backgroundColor: colors.selection,
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    slotLabel: {
      color: colors['on-selection'],
      fontSize: 14,
    },
    slotRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 6,
    },
    spinner: {
      marginHorizontal: 8,
    },
    title: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
    },
  });
