import {
  useGuardedMutations,
  useListColorLookup,
  useTaskInbox,
  useTaskReadOnlyLookup,
  useToday,
} from '@calendar/app-state';
import {
  calendarTaskKey,
  dueDayLabel,
  isOverdue,
  type TaskFold,
  taskFoldTitle,
  type TaskRecord,
} from '@calendar/core';
import { useMemo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TaskCheck } from './TaskCheck.tsx';
import { actionText, BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/**
 * The list behind a fold chip in the all-day lane: today's overdue or
 * undated tasks as a page sheet. The rows are the tasks the chip held when
 * it was tapped, drawn as they are now: one ticked here stays, struck
 * through, so the rows never shift under the finger and a slip can be
 * undone. A row opens its task in the editor, which takes the sheet's
 * place.
 */
export function TaskFoldSheet({
  fold,
  onClose,
  onEdit,
  tasks,
  timeZone,
}: {
  fold: TaskFold;
  onClose: () => void;
  onEdit: (task: TaskRecord) => void;
  /** The tasks the chip held when it was tapped. */
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
}) {
  const styles = useStyles(makeStyles);
  const inbox = useTaskInbox(timeZone);
  const today = useToday(timeZone);
  const listColorOf = useListColorLookup();
  const isReadOnly = useTaskReadOnlyLookup();
  const { completeTask } = useGuardedMutations();
  // Every task the calendar reads, as it is now: ticked today, a task
  // moves from its group to "done today", and is still found here.
  const current = useMemo(
    () =>
      new Map(
        [
          ...inbox.overdue,
          ...inbox.today,
          ...inbox.noDate,
          ...inbox.upcoming,
          ...inbox.completedToday,
        ].map((task) => [calendarTaskKey(task), task]),
      ),
    [inbox],
  );
  // A task deleted since (here, or on another device) drops out.
  const rows = tasks.flatMap((task) => current.get(calendarTaskKey(task)) ?? []);
  const title = taskFoldTitle(fold);
  const toggle = (task: TaskRecord) =>
    void completeTask({
      accountId: task.accountId,
      status: task.status === 'completed' ? 'needsAction' : 'completed',
      taskId: task.id,
      taskListId: task.listId,
    });

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <View style={styles.container} testID={`task-fold-sheet-${fold}`}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={onClose} testID="task-fold-close">
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.close}>
              Close
            </Text>
          </Pressable>
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          {/* Balances the Close button, so the title sits in the middle. */}
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            maxFontSizeMultiplier={BOX_FONT_SCALE}
            style={[styles.close, styles.hidden]}
          >
            Close
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          {rows.map((task) => {
            const done = task.status === 'completed';
            const readOnly = isReadOnly(task);
            const late = isOverdue(task, today);
            const due =
              late && task.dueDate !== undefined ? dueDayLabel(task.dueDate, today) : undefined;
            return (
              <View key={calendarTaskKey(task)} style={styles.row} testID={`fold-task-${task.id}`}>
                <Pressable
                  accessibilityLabel={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
                  accessibilityRole="button"
                  disabled={readOnly}
                  onPress={() => toggle(task)}
                  style={styles.check}
                  testID={`fold-task-toggle-${task.id}`}
                >
                  {({ pressed }) => (
                    <TaskCheck
                      checked={done}
                      disabled={readOnly}
                      listColor={listColorOf(task)}
                      overdue={late}
                      pressed={pressed}
                      size="list"
                    />
                  )}
                </Pressable>
                <Pressable
                  accessibilityLabel={due ? `${task.title}, ${due}` : task.title}
                  accessibilityRole="button"
                  onPress={() => onEdit(task)}
                  style={styles.rowBody}
                >
                  <Text numberOfLines={1} style={[styles.rowTitle, done && styles.rowDone]}>
                    {task.title}
                  </Text>
                  {/* The heading already says "Overdue". */}
                  {due ? <Text style={styles.rowLate}>{due}</Text> : null}
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // A 44 pt square; the box sits flush with the screen edge's inset.
    check: {
      alignItems: 'center',
      height: 44,
      justifyContent: 'center',
      marginLeft: -10,
      width: 44,
    },
    close: {
      ...actionText(colors),
      fontSize: 16,
    },
    container: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    content: {
      gap: 2,
      paddingBottom: 24,
      paddingHorizontal: 16,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    hidden: {
      opacity: 0,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 2,
    },
    rowBody: {
      alignItems: 'center',
      flex: 1,
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'space-between',
    },
    rowDone: {
      color: colors['text-secondary'],
      textDecorationLine: 'line-through',
    },
    rowLate: {
      color: colors.danger,
      fontSize: 13,
    },
    rowTitle: {
      color: colors.text,
      flex: 1,
      fontSize: 16,
    },
    title: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
    },
  });
