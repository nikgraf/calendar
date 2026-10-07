import type { EventRecord, TaskRecord } from '@calendar/core';
import type { useEventDrag } from '../useEventDrag.ts';
import { TaskInbox } from './TaskInbox.tsx';
import { UpNextCard } from './UpNextCard.tsx';

/** The panel at rest: what is next, and the tasks that want today. */
export function TodayRail({
  drag,
  onEditTask,
  onOpenEvent,
  timeZone,
}: {
  drag: ReturnType<typeof useEventDrag>;
  onEditTask: (task: TaskRecord) => void;
  onOpenEvent: (event: EventRecord) => void;
  timeZone: string;
}) {
  return (
    <>
      <UpNextCard onOpen={onOpenEvent} timeZone={timeZone} />
      <TaskInbox drag={drag} onEdit={onEditTask} timeZone={timeZone} />
    </>
  );
}
