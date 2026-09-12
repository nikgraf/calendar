import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { deviceSettingsKey } from './keys.ts';
import type { DeviceSettingRow } from './rows.ts';

/**
 * Device-local key/value preferences that never sync between devices —
 * the birthday reminder settings are the first. No account guard: these
 * belong to the device, not to an account. Values are JSON; a value that
 * no longer parses reads as null so a bad row cannot wedge its feature.
 */
export interface DeviceSettingsRepoShape {
  readonly get: (key: string) => Effect.Effect<unknown, SqlError>;
  readonly set: (key: string, value: unknown) => Effect.Effect<void, SqlError>;
}

const makeDeviceSettingsRepo: Effect.Effect<
  DeviceSettingsRepoShape,
  never,
  Reactivity | SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const reactivity = yield* Reactivity;
  return {
    get: (key) =>
      Effect.map(
        sql<DeviceSettingRow>`SELECT * FROM device_settings WHERE key = ${key}`,
        (rows) => {
          const row = rows[0];
          if (!row) {
            return null;
          }
          try {
            return JSON.parse(row.value) as unknown;
          } catch {
            return null;
          }
        },
      ),
    set: (key, value) =>
      reactivity.mutation(
        [deviceSettingsKey(key)],
        Effect.asVoid(sql`
            INSERT INTO device_settings (key, value, updated_at)
            VALUES (${key}, ${JSON.stringify(value)}, ${Date.now()})
            ON CONFLICT (key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at
          `),
      ),
  };
});

export class DeviceSettingsRepo extends Context.Service<
  DeviceSettingsRepo,
  DeviceSettingsRepoShape
>()('db/DeviceSettingsRepo') {
  static readonly layer: Layer.Layer<DeviceSettingsRepo, never, Reactivity | SqlClient> =
    Layer.effect(DeviceSettingsRepo)(makeDeviceSettingsRepo);
}
