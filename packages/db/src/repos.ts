import { Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import { AccountRepo } from './accountRepo.ts';
import { CalendarRepo } from './calendarRepo.ts';
import { ContactRepo } from './contactRepo.ts';
import { EventRepo } from './eventRepo.ts';
import { PendingOpRepo } from './pendingOpRepo.ts';
import { SyncStateRepo } from './syncStateRepo.ts';
import { TaskRepo } from './taskRepo.ts';

/** One file per table; this module only assembles the layer. */
export * from './accountRepo.ts';
export * from './calendarRepo.ts';
export * from './eventRepo.ts';
export * from './pendingOpRepo.ts';
export * from './syncStateRepo.ts';
export * from './taskRepo.ts';
export * from './contactRepo.ts';

export const reposLayer: Layer.Layer<
  AccountRepo | CalendarRepo | ContactRepo | EventRepo | PendingOpRepo | SyncStateRepo | TaskRepo,
  never,
  Reactivity | SqlClient
> = Layer.mergeAll(
  AccountRepo.layer,
  CalendarRepo.layer,
  ContactRepo.layer,
  EventRepo.layer,
  PendingOpRepo.layer,
  SyncStateRepo.layer,
  TaskRepo.layer,
);
