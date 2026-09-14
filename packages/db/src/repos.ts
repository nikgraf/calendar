import { Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import { AccountRepo } from './accountRepo.ts';
import { BirthdayRepo } from './birthdayRepo.ts';
import { CalendarRepo } from './calendarRepo.ts';
import { ContactRepo } from './contactRepo.ts';
import { DeviceSettingsRepo } from './deviceSettingsRepo.ts';
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
export * from './birthdayRepo.ts';
export * from './deviceSettingsRepo.ts';

export const reposLayer: Layer.Layer<
  | AccountRepo
  | BirthdayRepo
  | CalendarRepo
  | ContactRepo
  | DeviceSettingsRepo
  | EventRepo
  | PendingOpRepo
  | SyncStateRepo
  | TaskRepo,
  never,
  Reactivity | SqlClient
> = Layer.mergeAll(
  AccountRepo.layer,
  BirthdayRepo.layer,
  CalendarRepo.layer,
  ContactRepo.layer,
  DeviceSettingsRepo.layer,
  EventRepo.layer,
  PendingOpRepo.layer,
  SyncStateRepo.layer,
  TaskRepo.layer,
);
