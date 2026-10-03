import {
  MIRROR_STATUS_OFF,
  MirrorDefinition,
  type MirrorDefinition as Mirror,
  mirrorsIssue,
  MirrorStatus,
  normalizeMirror,
  sameMirrorSubstance,
} from '@calendar/core';
import { DeviceSettingsRepo } from '@calendar/db';
import { Effect, Schema } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

/**
 * Where mirrors live. Two device_settings rows, on purpose:
 *
 * - `mirrors`: the definitions. Portable — exported in the settings
 *   document, so the Mac and the iPhone can run the same mirror.
 * - `mirrors.local`: what is this device's own — whether a mirror runs
 *   here, how its last run went, and the bookkeeping that keeps two
 *   devices from fighting. Never exported.
 */
export const MIRRORS_KEY = 'mirrors';
export const MIRRORS_LOCAL_KEY = 'mirrors.local';

const decodeMirror = Schema.decodeUnknownEffect(MirrorDefinition);

/**
 * The stored definitions. One that no longer decodes (a zone tzdata
 * dropped, a hand edit) is skipped rather than taking the others with it.
 */
export const readMirrors: Effect.Effect<
  ReadonlyArray<Mirror>,
  SqlError,
  DeviceSettingsRepo
> = Effect.gen(function* () {
  const raw = yield* (yield* DeviceSettingsRepo).get(MIRRORS_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  const mirrors: Array<Mirror> = [];
  for (const entry of raw) {
    const decoded = yield* decodeMirror(entry).pipe(Effect.orElseSucceed(() => undefined));
    if (decoded !== undefined) {
      mirrors.push(normalizeMirror(decoded));
    }
  }
  return mirrors;
});

export const writeMirrors = (
  mirrors: ReadonlyArray<Mirror>,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.flatMap(DeviceSettingsRepo, (repo) =>
    repo.set(
      MIRRORS_KEY,
      // Canonical order, so an unchanged set writes identical text to the settings file.
      mirrors.map(normalizeMirror).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ),
  );

/** One mirror's device-local state. */
export const MirrorLocal = Schema.Struct({
  /** When a run first wanted to remove a large share of the copies and held back. */
  brakeSince: Schema.optional(Schema.Number),
  enabled: Schema.Boolean,
  /**
   * Writes of the last day, `keyHash:contentHash` (or `keyHash:x` for a
   * delete) → [count, last epoch ms]. The same write made a third time
   * means something keeps undoing it.
   */
  journal: Schema.optional(
    Schema.Record(Schema.String, Schema.Tuple([Schema.Number, Schema.Number])),
  ),
  /** The highest definition revision ever seen on this mirror's copies. */
  newestRev: Schema.optional(Schema.Number),
  status: Schema.optional(MirrorStatus),
});
export type MirrorLocal = typeof MirrorLocal.Type;

const MirrorLocals = Schema.Record(Schema.String, MirrorLocal);
const decodeLocals = Schema.decodeUnknownEffect(MirrorLocals);

export const DEFAULT_MIRROR_LOCAL: MirrorLocal = { enabled: false };

export const readMirrorLocals: Effect.Effect<
  Readonly<Record<string, MirrorLocal>>,
  SqlError,
  DeviceSettingsRepo
> = Effect.gen(function* () {
  const raw = yield* (yield* DeviceSettingsRepo).get(MIRRORS_LOCAL_KEY);
  if (raw === null) {
    return {};
  }
  return yield* decodeLocals(raw).pipe(Effect.orElseSucceed(() => ({})));
});

export const writeMirrorLocals = (
  locals: Readonly<Record<string, MirrorLocal>>,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.flatMap(DeviceSettingsRepo, (repo) => repo.set(MIRRORS_LOCAL_KEY, locals));

/** Changes one mirror's local state, leaving the others as stored. */
export const updateMirrorLocal = (
  mirrorId: string,
  change: (local: MirrorLocal) => MirrorLocal,
): Effect.Effect<MirrorLocal, SqlError, DeviceSettingsRepo> =>
  Effect.gen(function* () {
    const locals = yield* readMirrorLocals;
    const next = change(locals[mirrorId] ?? DEFAULT_MIRROR_LOCAL);
    yield* writeMirrorLocals({ ...locals, [mirrorId]: next });
    return next;
  });

export const mirrorStatusOf = (local: MirrorLocal | undefined): MirrorStatus =>
  local === undefined || !local.enabled ? MIRROR_STATUS_OFF : (local.status ?? MIRROR_STATUS_OFF);

export class MirrorSaveError extends Schema.Error<MirrorSaveError>('sync/MirrorSaveError')({
  message: Schema.String,
}) {}

/**
 * Adds a mirror or replaces the one with its id. The revision
 * (`updatedAt`) moves only when what the mirror writes changed — a rename
 * must not make the other device stand back — and never backwards.
 */
export const saveMirror = (
  definition: Mirror,
  nowMs: number,
): Effect.Effect<Mirror, MirrorSaveError | SqlError, DeviceSettingsRepo> =>
  Effect.gen(function* () {
    const mirrors = yield* readMirrors;
    const existing = mirrors.find((mirror) => mirror.id === definition.id);
    const unchanged = existing !== undefined && sameMirrorSubstance(existing, definition);
    const saved = normalizeMirror({
      ...definition,
      updatedAt: unchanged ? existing.updatedAt : Math.max(nowMs, (existing?.updatedAt ?? 0) + 1),
    });
    const next = [...mirrors.filter((mirror) => mirror.id !== saved.id), saved];
    const issue = mirrorsIssue(next);
    if (issue !== undefined) {
      return yield* new MirrorSaveError({ message: issue });
    }
    yield* writeMirrors(next);
    return saved;
  });

/** Forgets a mirror and its local state. Its copies are the caller's business. */
export const removeMirror = (mirrorId: string): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.gen(function* () {
    const mirrors = yield* readMirrors;
    yield* writeMirrors(mirrors.filter((mirror) => mirror.id !== mirrorId));
    const { [mirrorId]: _gone, ...rest } = yield* readMirrorLocals;
    yield* writeMirrorLocals(rest);
  });

/**
 * What an imported set of mirrors changes here: a mirror this device does
 * not have is added (switched off — a device runs a mirror only once its
 * user turned it on there), one it has is replaced when the file's is
 * newer. A file that differs under the same revision was edited by hand:
 * it is taken and stamped now, so other devices notice. Nothing is ever
 * removed, and a mirror that would collide with one kept here is left out
 * and named.
 */
export const planMirrorImport = (
  current: ReadonlyArray<Mirror>,
  incoming: ReadonlyArray<Mirror>,
  nowMs: number,
): {
  readonly added: ReadonlyArray<Mirror>;
  readonly next: ReadonlyArray<Mirror>;
  readonly skipped: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<Mirror>;
} => {
  const added: Array<Mirror> = [];
  const updated: Array<Mirror> = [];
  const skipped: Array<string> = [];
  let next = [...current];
  for (const raw of incoming) {
    let mirror = normalizeMirror(raw);
    const existing = next.find((entry) => entry.id === mirror.id);
    if (existing !== undefined) {
      if (mirror.updatedAt < existing.updatedAt) {
        continue;
      }
      if (mirror.updatedAt === existing.updatedAt) {
        const same = sameMirrorSubstance(existing, mirror);
        if (same && existing.name === mirror.name) {
          continue;
        }
        if (!same) {
          mirror = { ...mirror, updatedAt: Math.max(nowMs, existing.updatedAt + 1) };
        }
      }
    }
    const candidate = [...next.filter((entry) => entry.id !== mirror.id), mirror];
    const issue = mirrorsIssue(candidate);
    if (issue !== undefined) {
      skipped.push(issue);
      continue;
    }
    next = candidate;
    (existing === undefined ? added : updated).push(mirror);
  }
  return { added, next, skipped, updated };
};
