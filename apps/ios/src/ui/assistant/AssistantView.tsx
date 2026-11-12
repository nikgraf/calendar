import {
  changedLine,
  describeDraftItem,
  type Draft,
  draftCalendarKey,
  draftListKey,
  type FieldChange,
  stepSummary,
  type useModelAvailability,
  type useThreadEditor,
  versionLabel,
} from '@calendar/app-state';
import type { CalendarInfo, TaskListInfo } from '@calendar/core';
import { SymbolView } from 'expo-symbols';
import { type ReactNode, useRef } from 'react';
import {
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ModelAvailabilityNotice } from '../ModelAvailabilityNotice.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { AssistantCard } from './AssistantCard.tsx';
import { DraftQuestions } from './DraftQuestions.tsx';

/**
 * A step that is not the one on show, in one line: which version it left,
 * what it did, and the way to it. Later ones — stepped back over — are
 * dimmed.
 */
function VersionRow({
  dimmed = false,
  disabled,
  label,
  onRestore,
  summary,
}: {
  readonly dimmed?: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onRestore: () => void;
  readonly summary: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.version, dimmed && styles.dimmed]} testID="assistant-version">
      <View style={styles.versionText}>
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.versionLabel}>
          {label.toUpperCase()}
        </Text>
        <Text numberOfLines={1} style={styles.versionSummary}>
          {summary}
        </Text>
      </View>
      <Pressable
        accessibilityLabel={`Restore ${label}`}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={6}
        onPress={onRestore}
        style={[styles.textButton, disabled && styles.disabled]}
        testID="assistant-restore"
      >
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.textButtonLabel}>
          Restore
        </Text>
      </Pressable>
    </View>
  );
}

/** Under the newest card: what the step changed, in a line, then Undo (a step back) and Edit (the form). */
function CardFooter({
  changes,
  onEdit,
  steps,
}: {
  readonly changes: ReadonlyArray<FieldChange>;
  readonly onEdit: () => void;
  readonly steps: ReturnType<typeof useThreadEditor>['steps'];
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.footer}>
      <Text numberOfLines={1} style={styles.changed} testID="assistant-changed">
        {changedLine(changes)}
      </Text>
      <View style={styles.footerActions}>
        {steps.at > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: steps.locked }}
            disabled={steps.locked}
            onPress={steps.back}
            style={[styles.textButton, steps.locked && styles.disabled]}
            testID="assistant-undo"
          >
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.textButtonLabel}>
              Undo
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={onEdit}
          style={styles.textButton}
          testID="assistant-edit"
        >
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.textButtonLabel}>
            Edit
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The step on show as cards: the draft the form shows open, with what the
 * step changed marked — unless the step made it, when all of it is new
 * and nothing is "changed" — and any other draft as a line that brings
 * it into the form; under them, while it is the newest step, what the
 * assistant has to ask.
 */
function StepAnswer({
  calendars,
  editor,
  note,
  onEdit,
  taskLists,
}: {
  readonly calendars: ReadonlyArray<CalendarInfo>;
  readonly editor: ReturnType<typeof useThreadEditor>;
  readonly note: string | undefined;
  readonly onEdit: () => void;
  readonly taskLists: ReadonlyArray<TaskListInfo>;
}) {
  const styles = useStyles(makeStyles);
  const { assistant, drafts, eventModel, focused, marks, previewing, steps, taskModel } = editor;
  /** Where a draft goes, by name and color: the focused one where the form points. */
  const containerOf = (draft: Draft, index: number) => {
    if (draft.item.kind === 'task') {
      const key = index === focused ? taskModel.listKey : draftListKey(draft, taskLists, '');
      const list = taskLists.find((each) => `${each.accountId}:${each.id}` === key);
      return { color: list?.colorHex, name: list?.title };
    }
    const key =
      index === focused
        ? eventModel.calendarKey
        : draftCalendarKey(draft, calendars, eventModel.calendarKey);
    const calendar = calendars.find((each) => `${each.accountId}:${each.id}` === key);
    return { color: calendar?.colorHex, name: calendar?.summary };
  };
  const shown = steps.line[steps.at - 1];
  const label =
    steps.at === 0 ? (assistant === 'saved' ? 'As saved' : '') : `Version ${String(steps.at)}`;
  return (
    <>
      {drafts.map((draft, index) => {
        if (index !== focused) {
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !editor.settled }}
              disabled={!editor.settled}
              key={draft.id}
              onPress={() => editor.switchFocus(index)}
              style={styles.otherDraft}
              testID="assistant-draft"
            >
              <Text numberOfLines={1} style={styles.otherTitle}>
                {draft.item.prefill.title || 'Untitled'}
              </Text>
              <Text numberOfLines={1} style={styles.otherWhen}>
                {describeDraftItem(draft.item)}
              </Text>
            </Pressable>
          );
        }
        const container = containerOf(draft, index);
        const existed = shown?.before.drafts.some((each) => each.id === draft.id) ?? false;
        const changes = existed ? (marks?.changes ?? []) : [];
        return (
          <AssistantCard
            changes={changes}
            color={container.color}
            container={container.name}
            draft={draft}
            footer={
              previewing ? null : <CardFooter changes={changes} onEdit={onEdit} steps={steps} />
            }
            key={draft.id}
            label={label}
          />
        );
      })}
      {previewing ? null : <DraftQuestions editor={editor} note={note} />}
    </>
  );
}

/**
 * The assistant's view of the editor: a conversation, as on the desktop.
 * What was said or typed is on the right; each answer is the item as a
 * card, with what the step changed marked and the old value struck
 * through, and under the newest whatever the assistant has to ask
 * (`DraftQuestions`). Steps that are not on show are one line each with
 * Restore, which puts that version on show ("Use this" then keeps it);
 * an edit made by hand in the form is listed among them. The newest row
 * is the one to read, so the conversation sits at its end. Without the
 * model it says why, with Check Again. What to say next is the bar's,
 * under it (`AssistantBar`).
 */
export function AssistantView({
  availability,
  banner,
  calendars,
  editor,
  note,
  onEdit,
  pending,
  taskLists,
}: {
  readonly availability: ReturnType<typeof useModelAvailability>;
  /** Above the conversation: the lesson's frame. */
  readonly banner?: ReactNode;
  readonly calendars: ReadonlyArray<CalendarInfo>;
  readonly editor: ReturnType<typeof useThreadEditor>;
  /** A caveat about the drafts (the shared text was cut short). */
  readonly note?: string | undefined;
  /** To the form, on the same draft. */
  readonly onEdit: () => void;
  /** The words being read, until their answer lands. */
  readonly pending?: string | undefined;
  readonly taskLists: ReadonlyArray<TaskListInfo>;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { assistant, labels, steps } = editor;
  const scroller = useRef<ScrollViewInstance>(null);
  // The newest row is the one to read: the conversation sits at its end,
  // whichever of the two changed — what it holds, or the room it has (the
  // keyboard and the field coming and going). `scrollToEnd` does nothing
  // once the rows fit again, which left them scrolled half out of view
  // above an empty stretch, so the offset is set outright.
  const sizes = useRef({ content: 0, view: 0 });
  const toEnd = (animated: boolean) => {
    const { content, view } = sizes.current;
    scroller.current?.scrollTo({ animated, y: Math.max(content - view, 0) });
  };
  const unavailable = availability.status !== null && availability.status !== 'ready';
  const started = steps.of > 0;
  const answer = (
    <StepAnswer
      calendars={calendars}
      editor={editor}
      note={note}
      onEdit={onEdit}
      taskLists={taskLists}
    />
  );
  const saved = steps.line[0]?.before.drafts[0];
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={(_width, height) => {
        sizes.current.content = height;
        toEnd(true);
      }}
      onLayout={(event) => {
        sizes.current.view = event.nativeEvent.layout.height;
        toEnd(false);
      }}
      ref={scroller}
      style={styles.thread}
      testID="assistant-thread"
    >
      {banner}
      {unavailable && availability.availability ? (
        <View testID="assistant-unavailable">
          <ModelAvailabilityNotice
            availability={availability.availability}
            checkedAt={availability.checkedAt}
            lastManualCheck={availability.lastManualCheck}
            manualChecking={availability.manualChecking}
            onCheckAgain={availability.retry}
          />
        </View>
      ) : null}
      {!started && assistant === 'new' && !pending && !unavailable ? (
        <View style={styles.empty}>
          <SymbolView name="sparkles" size={22} tintColor={colors['text-secondary']} />
          <Text style={styles.emptyTitle}>Say what to add</Text>
          <Text style={styles.emptyHint}>
            “Lunch with Sarah tomorrow at 1”, then change it the same way: “at 12:30”, “invite Tom”.
          </Text>
        </View>
      ) : null}
      {assistant === 'saved' && steps.at > 0 ? (
        <VersionRow
          disabled={steps.locked}
          label="As saved"
          onRestore={() => steps.show(0)}
          summary={saved ? describeDraftItem(saved.item) : ''}
        />
      ) : null}
      {steps.at === 0 && (assistant === 'saved' || !started) ? answer : null}
      {steps.at === 0 && assistant === 'new' && started ? (
        <Text style={styles.start} testID="assistant-start">
          Before the first step: nothing yet.
        </Text>
      ) : null}
      {steps.line.map((line) => (
        <View key={line.step.id} style={styles.step}>
          {line.step.kind === 'phrase' ? (
            <Text
              selectable
              style={[styles.said, line.dimmed && styles.dimmed]}
              testID="assistant-said"
            >
              {line.step.utterance}
            </Text>
          ) : null}
          {line.position === steps.at ? (
            answer
          ) : (
            <VersionRow
              dimmed={line.dimmed}
              disabled={steps.locked}
              label={versionLabel(line)}
              onRestore={() => steps.show(line.position)}
              summary={stepSummary(line, labels)}
            />
          )}
        </View>
      ))}
      {pending ? (
        <Text style={[styles.said, styles.dimmed]} testID="assistant-pending">
          {pending}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    changed: {
      color: colors['text-secondary'],
      flex: 1,
      fontSize: 13,
    },
    // The rows sit at the bottom, by the bar, until they fill the view.
    content: {
      flexGrow: 1,
      gap: 10,
      justifyContent: 'flex-end',
      paddingBottom: 12,
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    dimmed: {
      opacity: 0.5,
    },
    disabled: {
      opacity: 0.35,
    },
    empty: {
      alignItems: 'center',
      flex: 1,
      gap: 6,
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    emptyHint: {
      color: colors['text-secondary'],
      fontSize: 14,
      lineHeight: 19,
      textAlign: 'center',
    },
    emptyTitle: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
    },
    footer: {
      alignItems: 'center',
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'space-between',
    },
    footerActions: {
      flexDirection: 'row',
      gap: 4,
    },
    otherDraft: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 14,
      flexDirection: 'row',
      gap: 10,
      minHeight: 44,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    otherTitle: {
      color: colors.text,
      flex: 1,
      fontSize: 16,
      fontWeight: '500',
    },
    otherWhen: {
      color: colors['text-secondary'],
      flexShrink: 1,
      fontSize: 13,
    },
    /** What was said or typed: on the right, in the ink of an action. */
    said: {
      alignSelf: 'flex-end',
      backgroundColor: colors.primary,
      borderBottomLeftRadius: 20,
      borderBottomRightRadius: 6,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      color: colors['on-primary'],
      fontSize: 16,
      lineHeight: 21,
      marginLeft: 48,
      overflow: 'hidden',
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    start: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    step: {
      gap: 10,
    },
    textButton: {
      justifyContent: 'center',
      minHeight: 44,
      paddingHorizontal: 10,
    },
    textButtonLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    thread: {
      flex: 1,
    },
    version: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 14,
      flexDirection: 'row',
      gap: 8,
      paddingLeft: 14,
      paddingRight: 4,
    },
    versionLabel: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.3,
    },
    versionSummary: {
      color: colors['text-secondary'],
      fontSize: 15,
    },
    versionText: {
      flex: 1,
      gap: 1,
      paddingVertical: 8,
    },
  });
