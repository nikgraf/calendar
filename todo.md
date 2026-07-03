# TODO

## Follow-ups

- [ ] Real app icons (macOS .icns / Assets.car, iOS app icon set)
- [ ] Signing/notarization for the macOS app — already env-gated in
      `apps/desktop/forge.config.cjs` (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
      `APPLE_PASSWORD`, `APPLE_TEAM_ID`); needs Apple credentials
- [ ] EAS build / TestFlight distribution for the iOS app
- [ ] Native iOS date/time pickers in the event editor
      (`@react-native-community/datetimepicker` — replaces the text inputs;
      requires a prebuild)
- [ ] Drag-to-move / drag-to-resize events (reanimated + gesture-handler on
      iOS, pointer events on desktop)
- [ ] Recurring-event editing (single-instance overrides first, then
      this-and-following / whole series)

## Deferred architecture upgrades

Both were deliberately deferred during the initial build and have clean
upgrade paths:

- [x] Migrate UI state/data flow to `@effect/atom-react` — done: atoms
      subscribe to fine-grained Reactivity keys (`accounts`/`calendars`/
      `events`); backend invalidations flow through a forwarding bridge
- [x] Replace the hand-rolled Schema-typed IPC bridge with
      `effect/unstable/rpc` — done: `AppBackendRpcs` RpcGroup in core,
      custom duplex protocols over the Electron IPC frame channel
      (`packages/sync/src/rpcDuplex.ts`; a MessagePort transport is a
      drop-in duplex swap), and the invalidation stream is a typed
      `stream: true` rpc
