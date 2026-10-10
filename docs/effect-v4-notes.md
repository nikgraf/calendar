# Effect v4 notes

Every `effect*` package is pinned exactly to **4.0.1** through the pnpm
catalog, and Dependabot ignores them: the modules this app leans on
hardest (rpc, sql, http, reactivity) are still tagged `@stability
unstable` and may break in a minor release, so every bump is a deliberate,
all-packages-together change. v4 is a substantial break from v3; this is
the catalog of differences and traps we hit, each as symptom → cause →
fix. Tests import the runner from `vite-plus/test`; `@effect/vitest`
resolves the same `vitest` through the workspace override.

## API renames / removals

- **`Effect.fork` / `Effect.forkDaemon` don't exist.** Use
  `Effect.forkChild` (scoped to parent), `Effect.forkDetach` (daemon-like),
  or `Effect.forkIn`.
- **`Effect.dieMessage` is gone.** Symptom: `TypeError: yield*
  (intermediate value)... is not iterable` at the call site (the undefined
  import is invoked, then yield\*ed). Use `Effect.die(new Error('…'))`.
- **`HttpClientRequest.del` is now `delete`** (exported keyword-style:
  `HttpClientRequest.delete`).
- **`RpcClient.FromGroup` is a module-level type**, not nested under a
  namespace.
- **No `it.scoped` in @effect/vitest** — `it.effect` already provides a
  Scope.
- `Schema.isLengthBetween` became `Schema.isBetweenLength`.

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
  `Schema.encodeSync`. Error classes: `Schema.Error` / `Schema.TaggedError`;
  plain tagged errors via `Data.TaggedError`.
- `Schema.Class` instances spread cleanly (`new X({ ...existing, field })`)
  — used everywhere for record updates.
- With `exactOptionalPropertyTypes`, building values for
  `Schema.optional(...)` fields sometimes needs conditional spreads
  (`...(v === undefined ? {} : { v })`) instead of `v: maybeUndefined`.

## Reactivity / atoms

- The Reactivity **class and its `layer`** live at the deep path
  `effect/reactivity/Reactivity` (the barrel `effect/reactivity` exposes
  the namespace, and `layer` is a module-level export, not a static).
- `Atom.family` memoizes per key **forever** — unbounded key spaces leak.
  We use a 32-entry LRU for range and query atoms instead
  (`boundedAtomCache` in `packages/app-state/src/atoms.ts`).
- `AsyncResult.value(result)` carries the previous success during a
  refetch — the hooks read it so lists never flicker to empty.
- Mutations are `runtime.fn(effectFn, { reactivityKeys })`; reads are
  `runtime.atom(effect).pipe(Atom.withReactivity([keys]))`. `Atom.fn` runs
  latest-wins, so each mutation _call_ gets its own fn atom
  (`runMutation`) — a second quick call would otherwise interrupt the
  first and both read its result.
- `Reactivity.mutation(keys, effect)` invalidates after the effect;
  `invalidate`/`invalidateUnsafe` fire listeners directly.

## rpc (effect/rpc)

- Groups: `RpcGroup.make(Rpc.make('name', { payload, success, error }),
  …)`; payloads may be struct-field records or Schemas; streams via
  `stream: true`.
- Custom transports implement `RpcServer.Protocol` / `RpcClient.Protocol`
  with `Protocol.make` (`withRun` / `withRunClient`). A protocol record
  needs `supportsNotifications` (`true` for any transport that preserves
  message boundaries and supports server push) and must expose `codecFor`
  (forward `serialization.codecFor`, as effect's own socket/worker
  protocols do — without it the client fails at runtime with "codecFor is
  not a function"). See `packages/sync/src/rpcDuplex.ts` for the Electron
  IPC duplex pair. Routing: track requestId→clientId from `'Request'`
  frames; `'Exit'` deletes; everything else broadcasts.
- Serialization: `RpcSerialization.layerNdjson`. Pass
  `disableFatalDefects: true` to `RpcServer.layer` so handler defects
  surface as errors instead of killing the server.
- Server handlers come from `Group.toLayer({...handlers})`; normalize
  errors at the boundary (`mapToBackendError` collapses any Cause into the
  wire-format `BackendError`).

## SQL / migrations

- `SqlClient` deep import: `effect/sql/SqlClient` (the barrel re-exports
  `Migrator`, which Metro cannot parse — see below).
- `@effect/sql-sqlite-node` uses Node's built-in `node:sqlite`: no native
  module, no Electron-ABI rebuilds.
- Effect's `Migrator` uses a dynamic-import glob
  (`__rewriteRelativeImportExtension`) that **Metro cannot parse** → the
  repo has a hand-rolled `runMigrations` (`packages/db/src/migrate.ts`)
  compatible with the same `effect_sql_migrations` table.
- `ResolvedMigration` tuples: the third element is a **loader whose result
  is the migration effect** — wrap with `Effect.succeed(migrationEffect)`.
- iOS driver deep import: `@effect/sql-sqlite-react-native/SqliteClient`.

## Misc

- `Semaphore.makeUnsafe(1)` + `withPermits(1)(effect)` is the single-flight
  pattern (op queue, syncAll).
- `Stream.callback` + `Queue.offerUnsafe` + `Effect.acquireRelease` is the
  bridge from callback-world into a stream (the invalidations rpc).
- `cause.reasons` + `Cause.isFailReason` to dig typed failures out of a
  Cause at the rpc boundary.
- `ManagedRuntime.make(layer)` per platform entry point; top-level await
  of runtime setup is fine in the renderer, **not** in Electron main.
- Hermes lacks pieces of Intl that @js-temporal/polyfill expects
  (`Missing internal slot calendar-id`): `packages/core/src/time/intl-compat.ts`
  patches `Intl.DateTimeFormat.prototype.resolvedOptions` to include
  `calendar`/`numberingSystem`.
- A worklet (iOS UI-thread code, e.g. `packages/core/src/time/slotSelection.ts`)
  must not default a parameter to a module binding (`step = DRAG_SNAP_MINUTES`):
  the UI runtime unpacks captured values inside the body, after parameter
  defaults are evaluated, so the call throws a `ReferenceError` and a release
  build crashes. Resolve the default in the body (`step ?? DRAG_SNAP_MINUTES`);
  `apps/ios/src/workletClosures.test.ts` runs core worklets the way the UI
  runtime does.
