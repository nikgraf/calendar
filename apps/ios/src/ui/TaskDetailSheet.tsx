import {
  reminderAlarmLabel,
  taskDetailAction,
  useAction,
  useBackendMutations,
  useCurrentTask,
  useTaskReadOnlyLookup,
} from '@calendar/app-state';
import { formatPlainTime, type TaskListInfo, type TaskRecord, Temporal } from '@calendar/core';
import { useEffect, useEffectEvent, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { confirmEditorRequest } from './EventEditSheet.tsx';
import { SheetButton } from './SheetButton.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/** Tasks and reminders open here first; only Edit opens their form. */
export function TaskDetailSheet({
  onClose,
  onCompleted,
  onEdit,
  task: opened,
  taskLists,
}: {
  readonly onClose: () => void;
  /** A completion or deletion succeeded; close only a sheet still showing this task. */
  readonly onCompleted: (task: TaskRecord) => void;
  readonly onEdit: (task: TaskRecord) => void;
  readonly task: TaskRecord;
  readonly taskLists: ReadonlyArray<TaskListInfo>;
}) {
  const styles = useStyles(makeStyles);
  const [task, setTask] = useState(opened);
  const current = useCurrentTask(task);
  if (current !== null && current !== task) {
    setTask(current);
  }
  const gone = current === null;
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (gone) {
      close();
    }
  }, [gone]);
  const mutations = useBackendMutations();
  const readOnly = useTaskReadOnlyLookup()(task);
  const work = useAction();
  const perform = (action: 'complete' | 'delete') =>
    work.run(async () => {
      if (
        await taskDetailAction({ action, confirm: confirmEditorRequest, mutations, readOnly, task })
      ) {
        onCompleted(task);
      }
    });
  const list = taskLists.find(
    (item) => item.accountId === task.accountId && item.id === task.listId,
  );
  const reminder = task.provider === 'apple';
  const done = task.status === 'completed';
  const day = task.dueDate
    ? Temporal.PlainDate.from(task.dueDate).toLocaleString('en-US', {
        day: 'numeric',
        month: 'long',
        weekday: 'long',
      })
    : 'No due date';

  return (
    <View style={styles.container} testID="task-detail">
      <View style={styles.header}>
        <SheetButton label="Close" onPress={onClose} testID="task-detail-close" />
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={1} style={styles.listName}>
          {list?.title ?? (reminder ? 'Reminder' : 'Task')}
        </Text>
        <SheetButton label="Edit" onPress={() => onEdit(task)} primary testID="task-edit" />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text selectable style={styles.title} testID="task-detail-title">
          {task.title}
        </Text>
        <View style={styles.section}>
          <Text style={styles.primaryLine}>{day}</Text>
          {task.dueTime ? (
            <Text style={styles.secondaryLine}>{formatPlainTime(task.dueTime)}</Text>
          ) : null}
          {task.recurrence || task.recurrenceUnsupported ? (
            <Text style={styles.secondaryLine}>Repeating reminder</Text>
          ) : null}
          <Text style={styles.secondaryLine}>
            {done ? 'Completed' : reminder ? 'Reminder' : 'Task'}
          </Text>
        </View>
        {task.priority ? (
          <View style={styles.section}>
            <Text style={styles.label}>PRIORITY</Text>
            <Text style={styles.primaryLine}>
              {task.priority === 'high' ? 'High' : task.priority === 'medium' ? 'Medium' : 'Low'}
            </Text>
          </View>
        ) : null}
        {task.alarms?.length ? (
          <View style={styles.section}>
            <Text style={styles.label}>ALERTS</Text>
            {task.alarms.map((alarm, index) => (
              <Text key={index} style={styles.primaryLine}>
                {reminderAlarmLabel(alarm)}
              </Text>
            ))}
          </View>
        ) : null}
        {task.url ? (
          <View style={styles.section}>
            <Text style={styles.label}>LINK</Text>
            <Text
              accessibilityRole="link"
              onPress={() => void Linking.openURL(task.url!)}
              selectable
              style={styles.primaryLine}
            >
              {task.url}
            </Text>
          </View>
        ) : null}
        {task.notes ? (
          <View style={styles.section}>
            <Text style={styles.label}>NOTES</Text>
            <Text selectable style={styles.primaryLine} testID="task-detail-notes">
              {task.notes}
            </Text>
          </View>
        ) : null}
        {readOnly ? (
          <Text style={styles.secondaryLine} testID="task-read-only">
            This list is read-only in Reminders.
          </Text>
        ) : null}
        {work.error ? <Text style={styles.error}>{work.error}</Text> : null}
        {readOnly ? null : (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={work.busy}
              onPress={() => void perform('complete')}
              style={[styles.button, work.busy && styles.disabled]}
              testID="task-detail-complete"
            >
              <Text style={styles.buttonLabel}>{done ? 'Mark as Incomplete' : 'Mark as Done'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={work.busy}
              onPress={() => void perform('delete')}
              style={[styles.button, work.busy && styles.disabled]}
              testID="task-detail-delete"
            >
              <Text style={styles.deleteLabel}>Delete</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: { gap: 10 },
    button: {
      alignSelf: 'flex-start',
      backgroundColor: colors.fill,
      borderRadius: 10,
      justifyContent: 'center',
      minHeight: 44,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    buttonLabel: { color: colors.text, fontSize: 16, fontWeight: '600' },
    container: { backgroundColor: colors.canvas, flex: 1 },
    content: { gap: 18, padding: 16, paddingBottom: 48 },
    deleteLabel: { color: colors.danger, fontSize: 16, fontWeight: '600' },
    disabled: { opacity: 0.4 },
    error: { color: colors.danger, fontSize: 14 },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    label: { color: colors['text-secondary'], fontSize: 12, fontWeight: '600', letterSpacing: 0.4 },
    listName: { color: colors['text-secondary'], flex: 1, fontSize: 13, textAlign: 'center' },
    primaryLine: { color: colors.text, fontSize: 16 },
    secondaryLine: { color: colors['text-secondary'], fontSize: 14 },
    section: { gap: 4 },
    title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  });
