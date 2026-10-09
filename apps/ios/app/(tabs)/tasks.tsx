import {
  useGuardedMutations,
  useListColorLookup,
  useTaskInbox,
  useTaskLists,
  useTaskReadOnlyLookup,
  useTimeZones,
  useToday,
} from '@calendar/app-state';
import { overdueLabel, type TaskRecord, Temporal } from '@calendar/core';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useEditorHost } from '../../src/ui/EditorHost.tsx';
import { TaskCheck } from '../../src/ui/TaskCheck.tsx';
import { type ThemeColors, useStyles } from '../../src/ui/theme.ts';
import { MutationNoticeToast } from '../../src/ui/Toast.tsx';

/**
 * The Tasks tab: the inbox — overdue, today, no date, the next month,
 * done today — filtered by list, with a field that adds an undated task
 * to the first writable list. Rows open the task editor; the checkbox
 * completes at once, like the chips on the calendar.
 */
export default function TasksScreen() {
  const zones = useTimeZones();
  const timeZone = zones.loaded ? zones.primary : Temporal.Now.timeZoneId();
  return <TasksBody timeZone={timeZone} />;
}

function TasksBody({ timeZone }: { timeZone: string }) {
  const styles = useStyles(makeStyles);
  const host = useEditorHost();
  const inbox = useTaskInbox(timeZone);
  const today = useToday(timeZone);
  const taskLists = useTaskLists();
  const listColorOf = useListColorLookup();
  const isReadOnly = useTaskReadOnlyLookup();
  const { completeTask, createTask } = useGuardedMutations();
  const [listFilter, setListFilter] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const target = taskLists.find((list) => list.isVisible && !list.readOnly);

  const keep = (task: TaskRecord) =>
    listFilter === null || `${task.accountId}:${task.listId}` === listFilter;
  const toggle = (task: TaskRecord) =>
    void completeTask({
      accountId: task.accountId,
      status: task.status === 'completed' ? 'needsAction' : 'completed',
      taskId: task.id,
      taskListId: task.listId,
    });
  const add = () => {
    const trimmed = title.trim();
    if (!target || !trimmed) {
      return;
    }
    void createTask({ accountId: target.accountId, taskListId: target.id, title: trimmed });
    setTitle('');
  };

  const row = (task: TaskRecord, late: boolean) => {
    const done = task.status === 'completed';
    const readOnly = isReadOnly(task);
    const facts = [
      ...(late ? [overdueLabel(task, today)] : []),
      ...(task.dueDate && !late ? [`due ${task.dueDate}`] : []),
    ];
    return (
      <View key={`${task.listId}:${task.id}`} style={styles.row} testID={`task-row-${task.id}`}>
        <Pressable
          accessibilityLabel={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
          accessibilityRole="button"
          disabled={readOnly}
          onPress={() => toggle(task)}
          style={styles.check}
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
          accessibilityLabel={facts.length > 0 ? `${task.title}, ${facts.join(', ')}` : task.title}
          accessibilityRole="button"
          onPress={() => host.editTask(task)}
          style={styles.rowBody}
        >
          <Text numberOfLines={1} style={[styles.rowTitle, done && styles.rowDone]}>
            {task.title}
          </Text>
          {late ? (
            <Text style={styles.rowLate}>{overdueLabel(task, today)}</Text>
          ) : task.dueDate && task.dueDate !== today ? (
            <Text style={styles.rowMeta}>
              {Temporal.PlainDate.from(task.dueDate).toLocaleString('en-US', {
                day: 'numeric',
                month: 'short',
              })}
            </Text>
          ) : null}
        </Pressable>
      </View>
    );
  };
  const section = (label: string, tasks: ReadonlyArray<TaskRecord>, late = false) => {
    const shown = tasks.filter(keep);
    return shown.length === 0 ? null : (
      <View key={label} style={styles.section}>
        <Text style={styles.sectionLabel}>{label}</Text>
        {shown.map((task) => row(task, late))}
      </View>
    );
  };
  const empty = [inbox.overdue, inbox.today, inbox.noDate, inbox.upcoming].every(
    (tasks) => tasks.filter(keep).length === 0,
  );

  return (
    <SafeAreaView style={styles.screen} testID="tasks-screen">
      <StatusBar style="auto" />
      <View style={styles.header}>
        <Text style={styles.title}>Tasks</Text>
      </View>
      {taskLists.length > 1 ? (
        <ScrollView
          contentContainerStyle={styles.filters}
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {[
            { id: null, label: 'All' },
            ...taskLists.map((list) => ({ id: `${list.accountId}:${list.id}`, label: list.title })),
          ].map((entry) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: listFilter === entry.id }}
              key={entry.id ?? 'all'}
              onPress={() => setListFilter(entry.id)}
              style={[styles.filter, listFilter === entry.id && styles.filterActive]}
            >
              <Text
                style={[styles.filterLabel, listFilter === entry.id && styles.filterLabelActive]}
              >
                {entry.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {section('Overdue', inbox.overdue, true)}
        {section('Today', inbox.today)}
        {section('No date', inbox.noDate)}
        {section('Upcoming', inbox.upcoming)}
        {empty ? <Text style={styles.empty}>Nothing to do.</Text> : null}
        {inbox.completedToday.some(keep) ? (
          <Text style={styles.doneNote}>{inbox.completedToday.filter(keep).length} done today</Text>
        ) : null}
      </ScrollView>
      {/* A failed write (a list that lost its access) is told here, not only
          on the calendar — standing on the add field, which it never covers. */}
      <MutationNoticeToast />
      <View style={styles.addRow}>
        <Text style={styles.addPlus}>＋</Text>
        <TextInput
          accessibilityLabel="Add a task"
          editable={target !== undefined}
          onChangeText={setTitle}
          onSubmitEditing={add}
          placeholder={target ? `Add a task to ${target.title}` : 'No task list to add to'}
          returnKeyType="done"
          style={styles.addInput}
          testID="tasks-add"
          value={title}
        />
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    addInput: {
      color: colors.text,
      flex: 1,
      fontSize: 16,
      paddingVertical: 10,
    },
    addPlus: {
      color: colors['text-secondary'],
      fontSize: 18,
    },
    addRow: {
      alignItems: 'center',
      backgroundColor: colors['surface-subtle'],
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 16,
    },
    // A 44 pt square; the box sits flush with the screen edge's inset.
    check: {
      alignItems: 'center',
      height: 44,
      justifyContent: 'center',
      marginLeft: -10,
      width: 44,
    },
    content: {
      gap: 18,
      paddingBottom: 24,
      paddingHorizontal: 16,
    },
    doneNote: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    empty: {
      color: colors['text-secondary'],
      fontSize: 15,
      paddingVertical: 32,
      textAlign: 'center',
    },
    filter: {
      backgroundColor: colors.fill,
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    filterActive: {
      backgroundColor: colors.primary,
    },
    filterLabel: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
    filterLabelActive: {
      color: colors['on-primary'],
    },
    filters: {
      gap: 8,
      paddingBottom: 12,
      paddingHorizontal: 16,
    },
    header: {
      paddingHorizontal: 16,
      paddingVertical: 8,
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
    rowMeta: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    rowTitle: {
      color: colors.text,
      flex: 1,
      fontSize: 16,
    },
    screen: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    section: {
      gap: 2,
    },
    sectionLabel: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.4,
      paddingBottom: 4,
      textTransform: 'uppercase',
    },
    title: {
      color: colors.text,
      fontSize: 28,
      fontWeight: '700',
    },
  });
