# Effect v4 (pre-release) notes

The repo pins every `effect*` package to **4.0.0-rc.111** via the pnpm
catalog. v4 is a substantial break from v3 and the pre-releases are thinly
documented — this is the catalog of differences and traps we hit while
building, each as symptom → cause → fix. The beta.93 → rc.111 bump cost
exactly two code changes (`Schema.ErrorClass` rename, `supportsNotifications`
on the custom rpc protocol); everything else held.

## API renames / removals

- **`Effect.fork` / `Effect.forkDaemon` don't exist.** Use
  `Effect.forkChild` (scoped to parent), `Effect.forkDetach` (daemon-like),
  or `Effect.forkIn`.
- **`HttpClientRequest.del` is now `delete`** (exported keyword-style:
  `HttpClientRequest.delete`).
- **`RpcClient.FromGroup` is a module-level type**, not nested under a
  namespace.
- **No `it.scoped` in @effect/vitest** — `it.effect` already provides a
  Scope.

## Service / Layer patterns

- `Context.Tag` and `Effect.Service` are gone. Services are declared as
  two-stage classes:
  ```ts
  class Foo extends Context.Service<Foo, FooShape>()('pkg/Foo') {}
  ```
- `Layer.effect` is **curried**: `Layer.effect(Foo)(makeEffect)`.
- `Layer.mergeAll(a, b)` does **not** feed dependencies between siblings —
  use `Layer.provide` / `Layer.provideMerge` chains when one layer needs
  another.

## Schema

- Lives at `effect/Schema`. `Schema.Literals` takes an **array**
  (`Schema.Literals(['a', 'b'])`). Decoding via
  `Schema.decodeUnknownEffect` / `decodeUnknownSync`, encoding via
  `Schema.encodeSync`. Error classes: `Schema.Error` / `Schema.TaggedError`
  (renamed from `ErrorClass` / `TaggedErrorClass` in beta.104; the JS
  `Error` instance schema is `Schema.ErrorInstance`); plain tagged errors
  via `Data.TaggedError`.
- `Schema.Class` instances spread cleanly (`new X({ ...existing, field })`)
  — used everywhere for record updates.
- With `exactOptionalPropertyTypes`, building values for
  `Schema.optional(...)` fields sometimes needs conditional spreads
  (`...(v === undefined ? {} : { v })`) instead of `v: maybeUndefined`.

## Reactivity / atoms

- The Reactivity **class and its `layer`** live at the deep path
  `effect/unstable/reactivity/Reactivity` (the barrel
  `effect/unstable/reactivity` exposes the namespace, and `layer` is a
  module-level export, not a static).
- `Atom.family` memoizes per key **forever** — unbounded key spaces leak.
  We replaced it with a 32-entry LRU for range atoms
  (`packages/app-state/src/atoms.ts`).
- `AsyncResult.value(result)` returns an Option carrying
  `previousSuccess` during refetch — the hooks unwrap it so lists never
  flicker to empty.
- Mutations are `runtime.fn(effectFn, { reactivityKeys })`; reads are
  `runtime.atom(effect).pipe(Atom.withReactivity([keys]))`.
- `Reactivity.mutation(keys, effect)` invalidates after the effect;
  `invalidate`/`invalidateUnsafe` fire listeners directly.

## rpc (effect/unstable/rpc)

- Groups: `RpcGroup.make(Rpc.make('name', { payload, success, error }),
…)`; payloads may be struct-field records or Schemas; streams via
  `stream: true`.
- Custom transports implement `RpcServer.Protocol` / `RpcClient.Protocol`
  with `Protocol.make` (`withRun` / `withRunClient`) — see below. Server
  protocol records need `supportsNotifications` (added ~rc.108): `true` for
  any transport that preserves message boundaries and supports server push
  (buffered/unframed HTTP is the case that can't). See
  `packages/sync/src/rpcDuplex.ts` for the Electron IPC duplex pair.
  Routing: track requestId→clientId from `'Request'` frames; `'Exit'`
  deletes; everything else broadcasts.
- Serialization: `RpcSerialization.layerNdjson`. Pass
  `disableFatalDefects: true` to `RpcServer.layer` so handler defects
  surface as errors instead of killing the server.
- Server handlers come from `Group.toLayer({...handlers})`; normalize
  errors at the boundary (`mapToBackendError` collapses any Cause into the
  wire-format `BackendError`).

## SQL / migrations

- `SqlClient` deep import: `effect/unstable/sql/SqlClient` (the barrel
  re-exports `Migrator`, which Metro cannot parse — see below).
- `@effect/sql-sqlite-node` switched from better-sqlite3 to Node's
  built-in `node:sqlite` somewhere on the rc line — silently, via the
  version bump. It removed every Electron-ABI concern (electron-rebuild,
  the Node-ABI test twin, native build allowances) but also broke the
  Forge packaging copy list, which nothing before `make` exercises.
- Effect's `Migrator` uses a dynamic-import glob
  (`__rewriteRelativeImportExtension`) that **Metro cannot parse** → the
  repo has a hand-rolled `runMigrations` (`packages/db/src/migrate.ts`)
  compatible with the same `effect_sql_migrations` table.
- `ResolvedMigration` tuples: the third element is a **loader whose result
  is the migration effect** — wrap with `Effect.succeed(migrationEffect)`.
- iOS driver deep import: `@effect/sql-sqlite-react-native/SqliteClient`.

## Misc

- `Semaphore.makeUnsafe(1).withPermits(1)(effect)` is the single-flight
  pattern (op queue, syncAll).
- `Stream.callback` + `Queue.offerUnsafe` + `Effect.acquireRelease` is the
  bridge from callback-world into a stream (the invalidations rpc).
- `Cause.reasons` + `Cause.isFailReason` to dig typed failures out of a
  Cause at the rpc boundary.
- `ManagedRuntime.make(layer)` per platform entry point; top-level await
  of runtime setup is fine in the renderer, **not** in Electron main.
- Hermes lacks pieces of Intl that @js-temporal/polyfill expects
  (`Missing internal slot calendar-id`): `packages/core/src/time/intl-compat.ts`
  patches `Intl.DateTimeFormat.prototype.resolvedOptions` to include
  `calendar`/`numberingSystem`.
