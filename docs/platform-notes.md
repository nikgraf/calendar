# Platform notes

React Native, Expo, Reanimated and Gesture Handler on iOS, Electron on
the Mac, and the system behaviour under both that cost a debugging
session: each entry is symptom → cause → fix. Effect's own traps are in
`effect-v4-notes.md`; Maestro, CDP-harness and CI flake signatures in
`google-sync-and-testing.md`; step-by-step simulator procedures
(reproducing CI, a clean app state, recordings, lldb, EventKit probes)
in the `ios-simulator` skill (`.agents/skills/ios-simulator/SKILL.md`).

## Touches and the responder system (iOS)

- **An `onPress` that removes its own row eats the next tap on the
  page.** Symptom: after a swipe action deletes a row, the next tap
  anywhere on the page does nothing and the one after works (a Maestro
  "Element not found" on the following step). Cause: the touch's target
  unmounted while the touch was still being delivered, so React Native
  never sent the touch end to the page's ScrollView and its `_isTouching`
  stayed true; when the removal shrinks a scrolled page, the clamp's
  scroll event asks for the JS responder
  (`ScrollView._handleScrollShouldSetResponder`, true while touching) and
  gets it, so the next tap goes to the ScrollView. Fix: run such an action
  on the next tick, `setTimeout(action, 0)` (`GroupedList.tsx`'s swipe
  action). It only bites when the removal scrolls the page, so a change
  that makes a page taller can surface it in an unrelated flow.
- **A `Modal` rendered inside a ScrollView inherits that ScrollView's
  keyboard handling.** Symptom: with an input focused, the first tap on a
  row of a picker modal only dismisses the keyboard; the row never gets
  `onPressIn` and a second tap works. Cause: the responder system walks
  the React tree, not the native view tree, so the Modal is still
  "inside" the ScrollView that renders it. Fix:
  `keyboardShouldPersistTaps="handled"` on the outer ScrollView. Every new
  input plus pressable list inside a sheet needs it.
- **Probing a lost tap.** Temporary `console.log`s on the ScrollView
  (`onTouchStart/End/Cancel`, `onResponderGrant/Release`, `onScroll`,
  `onContentSizeChange`) and on the row (`onPressIn/Out`), Metro restarted
  with `--clear`, then the flow once and Metro's log: a responder grant
  right after a size change with no touch end before it is the
  signature above. For keyboard trouble, add a `Keyboard` listener and log
  `onResponderGrant` the same way.

## Gestures, Reanimated and the React Compiler

- **Two `activateAfterLongPress` pans both start.** Gesture Handler
  reports a long-press pan active (`onStart` runs) before UIKit honours
  `requireExternalGestureToFail`, so a pan that should wait on another
  starts too; the one UIKit fails afterwards never gets `onEnd` or
  `onFinalize`, and whatever state it set sticks (a block stayed lifted,
  no drag worked until relaunch). Never pair two long-press gestures
  through wait-for: give one gesture the whole region and branch on the
  touch-down position recorded in `onBegin` — not `onStart`'s, since a
  held finger drifts up to 10 pt before activation (`DraggableEventBlock`,
  decisions.md → One pan per iOS event block).
- **"Reading from `value` during component render", dozens of times per
  render.** Cause: a closure that reaches shared values passed in as
  props or params (`layout.containerX`) was handed to a Reanimated hook
  (`useAnimatedReaction`); the React Compiler then assumes the closure
  runs during render and keys its memo on `containerX.value`. Fix:
  `'use no memo'` as the hook's first statement (`useTaskDrag.ts`,
  `DayTimeline.tsx`). Local `useSharedValue` results, and files the
  compiler already skips (they write `.value`), are unaffected. To check
  a file, compile it alone with `babel-plugin-react-compiler` and
  `@babel/preset-typescript` and grep the output for
  `\$\[\d+\] !== \w+\.value`. To find where any warning comes from,
  temporarily patch `console.warn` in `apps/ios/index.ts` to print
  `new Error().stack` on one line (Metro collapses `node_modules` frames
  otherwise), `curl` the dev bundle from Metro and `sed -n '<line>p'` it.
- **A layout animation onto a just-mounted heavy view draws no frame of
  itself.** Symptom: `entering={FadeIn}` / `exiting={FadeOut}` on the
  editor shows no fade on the first open after launch and half a fade
  later. Cause: mounting the editor (the `@expo/ui` SwiftUI hosts fill in
  over several frames) holds the main thread past the whole 250 ms, and
  the layout animation's clock runs anyway. Fix (`RouteFade.tsx`, states in
  `routeFadeState.ts`): keep the old content mounted and visible
  (`pointerEvents="none"`, `accessibilityElementsHidden`), mount the new
  one at opacity 0, wait for its `onLayout` plus one
  `requestAnimationFrame`, then start `withTiming` on shared values: a
  timing started from JS takes its start time from its first UI frame, so
  every frame of it is drawn. Verify from a recording of the first open
  after launch (a run of ~16 ms frames across the 250 ms; recipe in the
  `ios-simulator` skill).
- Worklets must not default a parameter to a module binding: see
  effect-v4-notes.md → Misc.

## Expo, Metro and the dev client

- **Edits do not show up in the app.** Metro does not see a change made
  after it started when it runs with `CI=1` (no file watching) or
  without watchman (its fallback watcher missed every edit): each launch
  logs "iOS Bundled … (1 module)" and serves the old JS, so new debug logs
  never appear. An expo-router route component is a lazy chunk that a
  relaunched dev client can still get stale. Fix: stop Metro and start it
  again with `--clear` and the same `EXPO_PUBLIC_*` environment after
  every JS edit before a flow or a probe; compare file mtimes with Metro's
  start time when in doubt.
- **A new `EXPO_PUBLIC_*` value has no effect.** The values are inlined
  by Metro's transform, and its cache keeps the old ones until
  `expo start --clear`. Symptom seen: with `EXPO_PUBLIC_CALENDAR_MODEL=fixture`
  newly set, the real Apple model still answered (it replied to the
  fixture grammar with its prompt's own example). The `e2e-simulator`
  build never asks Metro at all: its JS, flags included, is embedded by
  `repack-app.sh`.
- **No log line from the app.** `console.log`/`console.warn` reach
  Metro's output only from a dev bundle; Effect's logger never does. Use
  temporary `console.warn('[dbg] …')` probes. `expo start --no-dev
  --minify` serves a production bundle to the dev client (CI-like JS
  without another install), but then nothing is logged.
- **The dev client crashes at bundle load** in
  `worklets::JSIWorkletsModuleProxy::toOptimizedObject`, or a native
  module is missing: the installed client was built for another native
  fingerprint than the JS it loads. `pnpm --filter @calendar/ios
  check:devclient` says so; install the build for the working tree's
  fingerprint (the `ios-simulator` skill).
- **An iOS 27 build dies before any JS** with `EXC_BREAKPOINT` in
  `___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke`:
  iOS 27 stops an app linked against its SDK unless it adopts the UIScene
  life cycle. Expo SDK 58's template does; an app delegate that drops
  scenes, or an older template, does not. Builds linked against the 26.x
  SDK (EAS's Xcode 26 image) are not checked (decisions.md → Xcode 27 and
  Expo SDK 58).
- **Under SDK 58 only a scene starts React Native.** A launch with no
  scene (a background task's) gets a headless host from
  `solunivo-background-launch` after 2 s (architecture.md → background
  refresh). Simulator facts for testing it: `BGTaskScheduler` never runs
  there; a `simctl push` content-available launch connects a background
  scene, so it is not scene-less; UIKit delivers the launch's scene as
  its own run-loop event ~30 ms after `didFinishLaunching` (hence the
  grace period). To stand in for a scene-less launch, spin the run loop
  inside `application(_:configurationForConnecting:)` (called only for a
  new scene session); spinning inside `didFinishLaunching` lets the scene
  through.

## iOS system behaviour

- **iOS 26 tab bar geometry** (NativeTabs, measured with `maestro
  hierarchy` on iPhone SE 3, 17e, 17 Pro and 17 Pro Max): the bar is
  83 pt tall and full width on every device; its items are 62 pt tall and
  top-aligned; the Search circle sits 21 pt from the right edge
  (`[319,791][381,853]` on the 402 × 874 pt 17 Pro). Taps in the gap
  between the Calendar/Tasks pill and Search pass through to React Native
  views under the bar; anything else in the 83 pt band is under the bar
  and loses its taps (a banner at `bottom: 24` sent them to "Tasks").
  Below iOS 26 the bar is a solid strip: gate pass-through placements on
  `Platform.Version` ≥ 26 (`AddButton.tsx`).
- **Safe areas inside a tab screen.** React Native's `SafeAreaView`
  inside a tab screen pads its bottom to the bar's top, so a zero-height
  last child lands exactly on the bar's top; absolute children of the
  `SafeAreaView` itself measure from the screen's edge, not from inside
  its padding (Fabric hit-tests overflowing children through
  `overflowInset`). The Search tab's root spans under the bar and
  `useSafeAreaInsets().bottom` is already 83 there: do not add the bar's
  height again (a toast floated 49 pt too high).
- **Hermes and V8 accept different IANA zone spellings** (Hermes, through
  the Temporal polyfill's Intl check, rejects `Asia/Kolkata` and
  `America/Buenos_Aires` but accepts `Asia/Calcutta` and
  `America/Argentina/Buenos_Aires`). A stored id the engine rejects fails
  the schema on the next read and resets the whole setting: ids pass
  through `runtimeZoneId` / `canonicalZoneId`
  (`packages/core/src/time/zones.ts`). Probe any engine-facing Intl or
  Temporal validation on Hermes before trusting a static list.
- **The simulator has no `SpeechTranscriber`** (`isAvailable` is false):
  a transcription there fails with "Audio format is not supported", which
  means no engine, not a bad file. Dictation is checked on a device or
  on the Mac.
- **Native-module adapters lie in tests when their fake copies the
  adapter.** A recorder adapter that never called the module's prepare
  step and read a getter the module does not have passed its unit test
  for seven weeks, because the fake mirrored the adapter. Type an adapter
  with the module's own exported class (a type-only import) and build its
  test fake from the guards in the native source.

## Electron (desktop)

- **A run hangs at the first token read or saved key.** A SecurityAgent
  dialog ("… wants to use … Safe Storage") is waiting: npm's Electron is
  ad-hoc signed, and the login keychain's "<app name> Safe Storage" item
  lists allowed apps by path, so an Electron binary at a new path (a new
  clone or worktree, a reinstalled `node_modules`) asks again, and every
  `safeStorage` call, sync or async, blocks until someone answers. Check
  with `pgrep -fl SecurityAgent` (its start time matches the first
  failure). The e2e harness never meets it (`--use-mock-keychain`); for a
  dev run with no one at the Mac, pass the same flag to Electron or keep
  the run away from stored tokens. The dialog is the user's to answer,
  never an agent's. Read an item's ACL (no secrets) with `security
  dump-keychain -a ~/Library/Keychains/login.keychain-db | awk
  'BEGIN{RS="keychain: "} /<service>/'`; failed launches leave Electron
  processes behind: `pkill -f "<checkout>/node_modules/electron/dist/Electron.app"`
  before measuring again.
- **Every sync fails with `TokenRefreshError: invalid_client` while the
  account still reads ok.** The run has no desktop OAuth client (a fresh
  clone has no gitignored `apps/desktop/google-oauth.local.json`), so it
  refreshes as client `unconfigured`. Pass `GOOGLE_DESKTOP_CLIENT_ID` /
  `GOOGLE_DESKTOP_CLIENT_SECRET` in the environment (README).
- **Main-process timers after the Mac sleeps.** libuv (Node 24 in
  Electron 45) reads `mach_continuous_time()`, so `process.hrtime` and
  `performance.now()` count sleep. But Electron main waits on libuv from
  an embed thread with `poll(backend_fd, timeout)`, and XNU's poll
  deadline runs on `mach_absolute_time`, which stops in sleep: after a
  wake a due timer waits out the awake rest of that timeout. Anything
  main-process JS starts (a timer, I/O, `setImmediate`) interrupts the
  poll (Electron's `UV_LOOP_INTERRUPT_ON_IO_CHANGE` patch), and
  `settingsFileSync.ts` always runs a 5 s interval, so real lateness after
  a wake is at most ~5 s. Work that must happen on wake goes in
  `powerMonitor` resume / unlock-screen handlers. In vitest,
  `vi.setSystemTime` moves `Date` and the fake timers but not
  `performance.now()`: model a sleep by spying `performance.now` and adding
  the slept milliseconds. Probe the clocks with `ELECTRON_RUN_AS_NODE=1
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron probe.mjs`.
