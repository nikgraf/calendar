import {
  getLastUsedTaskListKey,
  useGuardedMutations,
  useListColorLookup,
  useTaskInbox,
  useTaskLists,
  useTaskReadOnlyLookup,
  useTimeZones,
  useToday,
} from '@calendar/app-state';
import {
  defaultTodoList,
  flattenTaskTree,
  indentTaskDrop,
  nestSubtasks,
  outdentTaskDrop,
  overdueLabel,
  type TaskInboxRow,
  type TaskRecord,
  taskListKeyOf,
  Temporal,
  todoKindOf,
} from '@calendar/core';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LegacyPressable as GesturePressable } from 'react-native-gesture-handler';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AccountButton } from '../../src/ui/AccountButton.tsx';
import { AddButton } from '../../src/ui/AddButton.tsx';
import { useEditorHost } from '../../src/ui/EditorHost.tsx';
import { TaskCheck } from '../../src/ui/TaskCheck.tsx';
import { taskListChips, taskListKey } from '../../src/ui/taskListChips.ts';
import { type ThemeColors, useStyles } from '../../src/ui/theme.ts';
import { MutationNoticeToast } from '../../src/ui/Toast.tsx';

/**
 * Inside a swipeable row React Native's own Pressable never sees the tap
 * (the swipe's pan takes the touch first): those rows press through
 * gesture-handler's twin, as the Settings rows do.
 */
const SwipePressable = GesturePressable as unknown as typeof Pressable;

/**
 * The Tasks tab: the inbox — overdue, today, no date, the next month,
 * done today — filtered by list. Its "+" opens the editor on a new
 * undated to-do in the filtered list (else the last list used, else
 * Reminders, then a Google list). Rows open the task editor; the checkbox
 * completes at once, like the chips on the calendar. A Google subtask is
 * indented under its parent when both are in one section (`nestSubtasks`).
 *
 * Swiping a Google row right offers Indent — a subtask of the row above,
 * right where it is drawn — or, on a subtask, Outdent, as Apple Reminders
 * does; VoiceOver offers the same action. Top-level rows keep the
 * section's order (day, then title), so there is no drag to reorder.
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
  const { completeTask, reorderTask } = useGuardedMutations();
  const [listFilter, setListFilter] = useState<string | null>(null);
  const { active, chips } = taskListChips(taskLists, listFilter);

  const keep = (task: TaskRecord) =>
    active === null || taskListKey(task.accountId, task.listId) === active;
  const toggle = (task: TaskRecord) =>
    void completeTask({
      accountId: task.accountId,
      status: task.status === 'completed' ? 'needsAction' : 'completed',
      taskId: task.id,
      taskListId: task.listId,
    });
  /** A new to-do where the user is looking: undated, in the filtered list. */
  const addNew = () => {
    const list = defaultTodoList(taskLists, {
      filter: active,
      lastUsedKey: getLastUsedTaskListKey(),
    });
    host.openNew({
      dated: false,
      focused: Temporal.PlainDate.from(today),
      kind: list ? todoKindOf(list.provider) : 'reminder',
      listKey: list ? taskListKeyOf(list) : undefined,
    });
  };

  /**
   * One task's row, indented when it is drawn under its parent. A Google
   * row that can move a level swipes right to Indent or Outdent.
   */
  const row = (entry: TaskInboxRow, rows: ReadonlyArray<TaskInboxRow>, late: boolean) => {
    const { task } = entry;
    const parent = entry.depth === 1 ? entry.group : undefined;
    const done = task.status === 'completed';
    const readOnly = isReadOnly(task);
    const key = `${task.accountId}:${task.listId}:${task.id}`;
    const indent = readOnly ? null : indentTaskDrop(rows, task);
    const outdent = readOnly || indent ? null : outdentTaskDrop(rows, task);
    const drop = indent ?? outdent;
    const action = drop && {
      label: indent ? 'Indent' : 'Outdent',
      name: indent ? 'indent' : 'outdent',
      run: () =>
        void reorderTask({
          accountId: task.accountId,
          taskId: task.id,
          taskListId: task.listId,
          ...drop.placement,
        }),
    };
    const Press = action ? SwipePressable : Pressable;
    // VoiceOver does not see the indent.
    const facts = [
      ...(parent ? [`subtask of ${parent.title}`] : []),
      ...(late ? [overdueLabel(task, today)] : []),
      ...(task.dueDate && !late ? [`due ${task.dueDate}`] : []),
    ];
    const body = (
      <View
        key={action ? undefined : key}
        style={[styles.row, parent && styles.subtaskRow]}
        testID={`task-row-${task.id}`}
      >
        <Press
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
        </Press>
        <Press
          accessibilityActions={action ? [{ label: action.label, name: action.name }] : undefined}
          accessibilityLabel={facts.length > 0 ? `${task.title}, ${facts.join(', ')}` : task.title}
          accessibilityRole="button"
          onAccessibilityAction={(event) => {
            if (action && event.nativeEvent.actionName === action.name) {
              action.run();
            }
          }}
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
        </Press>
      </View>
    );
    return action ? (
      <ReanimatedSwipeable
        childrenContainerStyle={styles.swipeContent}
        key={key}
        leftThreshold={40}
        overshootLeft={false}
        renderLeftActions={(_progress, _translation, swipeable) => (
          <SwipePressable
            accessibilityRole="button"
            onPress={() => {
              swipeable.close();
              action.run();
            }}
            style={styles.swipeAction}
            testID={`task-${action.name}-${task.id}`}
          >
            <Text style={styles.swipeActionLabel}>{action.label}</Text>
          </SwipePressable>
        )}
      >
        {body}
      </ReanimatedSwipeable>
    ) : (
      body
    );
  };
  const section = (label: string, tasks: ReadonlyArray<TaskRecord>, late = false) => {
    const shown = tasks.filter(keep);
    if (shown.length === 0) {
      return null;
    }
    const rows = flattenTaskTree(nestSubtasks(shown));
    return (
      <View key={label} style={styles.section}>
        <Text style={styles.sectionLabel}>{label}</Text>
        {rows.map((entry) => row(entry, rows, late))}
      </View>
    );
  };
  const empty = [inbox.overdue, inbox.today, inbox.noDate, inbox.upcoming].every(
    (tasks) => tasks.filter(keep).length === 0,
  );

  return (
    <SafeAreaView style={styles.screen} testID="tasks-screen">
      <StatusBar style="auto" />
      <View style={styles.body}>
        <View style={styles.header}>
          <Text style={styles.title}>Tasks</Text>
          <AccountButton />
        </View>
        {chips.length > 0 ? (
          // A ScrollView flexes by default; the chip row keeps its own height
          // and leaves the rest to the list.
          <ScrollView
            contentContainerStyle={styles.filters}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.filterBar}
          >
            {chips.map((chip) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active === chip.id }}
                key={chip.id ?? 'all'}
                onPress={() => setListFilter(chip.id)}
                style={[styles.filter, active === chip.id && styles.filterActive]}
              >
                <Text style={[styles.filterLabel, active === chip.id && styles.filterLabelActive]}>
                  {chip.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <ScrollView contentContainerStyle={styles.content}>
          {section('Overdue', inbox.overdue, true)}
          {section('Today', inbox.today)}
          {section('No date', inbox.noDate)}
          {section('Upcoming', inbox.upcoming)}
          {empty ? <Text style={styles.empty}>Nothing to do.</Text> : null}
          {inbox.completedToday.some(keep) ? (
            <Text style={styles.doneNote}>
              {inbox.completedToday.filter(keep).length} done today
            </Text>
          ) : null}
        </ScrollView>
        {/* A failed write (a list that lost its access) is told here, not only
            on the calendar. */}
        <MutationNoticeToast />
      </View>
      {/* A new undated to-do in the list being looked at. */}
      <AddButton onPress={addNew} />
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: {
      flex: 1,
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
    filterBar: {
      flexGrow: 0,
      flexShrink: 0,
    },
    filterLabel: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
    filterLabelActive: {
      color: colors['on-primary'],
    },
    filters: {
      alignItems: 'center',
      gap: 8,
      paddingBottom: 12,
      paddingHorizontal: 16,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
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
    // A subtask's box lines up under its parent's title.
    subtaskRow: {
      paddingLeft: 36,
    },
    swipeAction: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 10,
      justifyContent: 'center',
      width: 92,
    },
    swipeActionLabel: {
      color: colors['on-primary'],
      fontSize: 15,
      fontWeight: '600',
    },
    // Opaque, so the action stays hidden behind the row until it is swiped.
    swipeContent: {
      backgroundColor: colors.canvas,
    },
    title: {
      color: colors.text,
      fontSize: 28,
      fontWeight: '700',
    },
  });
