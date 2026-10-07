import type { EventRecord, TaskRecord } from '@calendar/core';
import { TaskInbox } from './TaskInbox.tsx';
import { UpNextCard } from './UpNextCard.tsx';

/** The panel at rest: what is next, and the tasks that want today. */
export function TodayRail({
  onEditTask,
  onOpenEvent,
  timeZone,
}: {
  onEditTask: (task: TaskRecord) => void;
  onOpenEvent: (event: EventRecord) => void;
  timeZone: string;
}) {
  return (
    <>
      <UpNextCard onOpen={onOpenEvent} timeZone={timeZone} />
      <TaskInbox onEdit={onEditTask} timeZone={timeZone} />
    </>
  );
}
