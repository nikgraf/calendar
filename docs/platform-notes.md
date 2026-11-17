# Platform notes

React Native, Expo, Reanimated and Gesture Handler on iOS, Electron on
the Mac, the system frameworks under both (MapKit, SpeechAnalyzer, the
on-device models) and the tooling around them, wherever one cost a
debugging session: each entry is symptom → cause → fix. Effect's own
traps are in
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
- **React Native's `Pressable` never fires inside a `ReanimatedSwipeable`'s
  children**: the swipeable's gesture takes the touch. Use Gesture
  Handler's `Pressable` there (`GroupedList.tsx`).
- **`hitSlop` stops at the parent's bounds**: React Native clips a child's
  slop to its parent, so a small chip's slop cannot reach past the chip.
  Make the parent the target's size instead.
- **Probing a lost tap.** Temporary `console.log`s on the ScrollView
  (`onTouchStart/End/Cancel`, `onResponderGrant/Release`, `onScroll`,
  `onContentSizeChange`) and on the row (`onPressIn/Out`), Metro restarted
  with `--clear`, then the flow once and Metro's log: a responder grant
  right after a size change with no touch end before it is the
  signature above. For keyboard trouble, add a `Keyboard` listener and log
  `onResponderGrant` the same way.

## Layout, text and accessibility (iOS)

- **A chip row takes half the screen, or is cut off.** A horizontal
  `ScrollView` has `flexGrow: 1, flexShrink: 1` by default, so it shares
  the height with the list below it. Give the row `flexGrow: 0,
  flexShrink: 0` and center its content (`SearchFilterChips.tsx`).
- **A `flex: 1` child collapses to a thin bar** inside a column wrapper (a
  `SegmentedControl` did): its wrapper must be a row.
- **A top-only border on a rounded view bevels its corners.** Draw a
  separate hairline `View`.
- **React Native's `Switch` sits off its box on iOS 26**: the system
  switch is 63 × 28 pt while React Native lays out 51 × 31, so it draws
  about 14 pt above and 22 pt left of where the layout put it. Use
  `@expo/ui`'s `Switch` in a `Host matchContents` with `labelsHidden()`
  (`GroupedList.tsx`).
- **Typed text is black in dark mode**: a `TextInput`'s text color
  defaults to black whatever the scheme. Set it. (Light `on-warning` is
  white, so ink never goes on a warning surface.)
- **A programmatic selection loses to the tap's caret**: an iOS
  `TextInput` takes `setSelection` only about 120 ms after it gained
  focus. Delay it.
- **VoiceOver reads "add, Forward" on a row**: an accessible row reads the
  labels of the SF Symbol images inside it. Wrap the symbols in a view
  with `accessibilityElementsHidden`.

## Gestures, Reanimated and the React Compiler

- **Two `activateAfterLongPress` pans both start.** Gesture Handler
  reports a long-press pan active (`onActivate` runs) before UIKit honours
  `requireExternalGestureToFail`, so a pan that should wait on another
  starts too; the one UIKit fails afterwards never gets `onDeactivate`
  or `onFinalize`, and whatever state it set sticks (a block stayed lifted,
  no drag worked until relaunch). Never pair two long-press gestures
  through wait-for: give one gesture the whole region and branch on the
  touch-down position recorded in `onBegin` — not `onActivate`'s, since a
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
- **Gesture Handler 3 re-sends a gesture's config whenever its object
  changes.** The `use*Gesture` hooks memoize the config by identity and
  send a changed one to native (`setConfig` resets first), so a config
  built fresh on every render, in an uncompiled or `'use no memo'` scope,
  churns natively on every render: memoize it there by hand.
- **A fade that carries state does not run under Reduce Motion**:
  Reanimated layout animations default to `ReduceMotion.System` and are
  skipped. Pass `ReduceMotion.Never` where the motion says something (a
  new turn arriving, a changed field's flash: `ThreadTurnList.tsx`,
  `FlashView.tsx`).
- **The day pager draws a frame a column off.** React places and the UI
  thread only pans: React mirrors the swiped distance the UI thread
  reports and draws the strips there, with the pan as a transform. A UI
  thread reset tied to a render (a `runOnUI` from a layout effect) races
  the Fabric mount, so keep resets out of render-driven paths.
- Worklets must not default a parameter to a module binding: see
  effect-v4-notes.md → Misc.

## expo-router and react-native-screens

- **A page pushed into Settings from outside has no Back.** `router.push`
  into a nested stack from outside it (`/settings/x` from the calendar)
  ignores the layout's anchor (`unstable_settings = { anchor: 'index' }`)
  unless pushed with `{ withAnchor: true }` (`settingsCodeInbox.ts`).
- **`usePathname` lags one commit behind `router.push`**: the push is
  queued and dispatched in the navigation container's passive effect. A
  host rule that waits on a route keeps its own "asked" flag.
- **A pop the discard guard should block goes through.** expo-router 58's
  prevent-remove sets its state in a layout effect and its reducer
  decides a blocked pop at render, so a host's `router.back()` from a
  passive effect after the guard dropped is not blocked
  (`discardGuard.tsx`).
- **`ActionSheetIOS` ignores `anchor` on an iPhone**: React Native 0.88
  passes it to UIKit on iPad only, so on an iPhone under iOS 26 the sheet
  shows centred.
- **Form sheets** (react-native-screens) lay their content out as at most
  two subviews: a header `View` with `collapsable={false}` and one
  ScrollView, which must stay mounted across a kind switch (a ScrollView
  swapped in lands over the header). The route unmounts about 14 ms after
  `router.back()`, at the start of the slide-out, and UIKit silently
  refuses a page-sheet `Modal` mounted then: hold such a sheet until the
  form sheet is gone (`FORM_SHEET_DISMISS_MS` in `EditorHost.tsx`). The
  keyboard raises a half sheet to full with no detent event, and the
  sheet drops back once the keyboard hides; there is no imperative detent
  API.
- **Fractional detents are fractions of the full sheet's height**: on an
  iPhone 17 Pro, 50 % leaves about 5 hours of the timeline in view, 60 %
  about 3.5 and 75 % about 1.

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
- **Start Metro from `apps/ios`** (`pnpm --filter @calendar/ios start`),
  never the repo root, where Expo leaves a `tsconfig.json` and `.expo/`
  behind.
- **A Metro restart under a running dev client can crash it natively**
  (`Scheduler::uiManagerDidFinishTransaction`, SIGBUS). Not the app's
  code: launch it again.
- **`expo export` bundles `expo/AppEntry.js` after files moved**: Metro's
  cache still holds the old entry. Run it with `--clear`.
- **A deep link into Settings lands on the calendar**:
  `solunivo-dev://settings/...` reloads the app instead of routing. Tap
  through Settings.
- **`Updates.channel` is `''`, not `null`,** when no channel header is
  set, and a dev client reports `isEnabled` true, so the PR Preview page's
  Load section shows there too.
- **A new local Expo module fails with "unsupported (module)"**:
  `expo run:ios` does not run `pod install` again when a module is added,
  so `requireNativeModule` finds nothing. Run `pod install` in
  `apps/ios/ios` first (`docs/distribution.md` → Local Xcode build).
- **Native work runs out of order.** An Expo module's `AsyncFunction`s
  run on one serial queue (`expo.modules.AsyncFunctionQueue`); a Swift
  `Task` started from one may run in any order. Keep order-sensitive work
  in the closure itself.
- **After any `expo-sharing` bump**, check the generated
  `ios/expo-sharing-extension/Info.plist`: `MainTargetUrlScheme` must be
  a string and the display name the app's. `plugins/withShareExtension.cjs`
  patches both and relies on the upstream plugin's internals to do it.
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
- **Native-module adapters lie in tests when their fake copies the
  adapter.** A recorder adapter that never called the module's prepare
  step and read a getter the module does not have passed its unit test
  for seven weeks, because the fake mirrored the adapter. Type an adapter
  with the module's own exported class (a type-only import) and build its
  test fake from the guards in the native source.

## iOS system behaviour

- **A launch's time starts before its JavaScript.** React Native's own
  startup marker (`APP_STARTUP_START`) is set when its instance is
  created, after expo-updates' wait and the bundle's load. The launch
  times in Settings › Advanced › Diagnostics count from the process's
  start instead, read from the kernel (`sysctl` with `KERN_PROC_PID`, in
  `modules/solunivo-launch-timing`). A process iOS prewarmed
  (`ActivePrewarm=1` in its environment) may have started minutes before
  the tap, so its times count from UIKit's launch call. A reload in the
  same process (PR Preview's Load) and a background launch record nothing.
  Each step is written as it is reached, so a launch closed while it hung
  shows the step it never got to.

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
- **`toSorted is not a function` on iOS only**: Hermes has no
  `Array.prototype.toSorted`, and the Node unit tests pass anyway. Copy
  and `sort` in code that runs on the phone (`modelSpike.ts`).

## MapKit

- **A map snapshot shows points of interest it was told to hide.** An
  `MKStandardMapConfiguration` set as `options.preferredConfiguration`
  carries its own `pointOfInterestFilter`, and that one wins over
  `options.pointOfInterestFilter`: set the filter on the configuration
  (`GeoBridge.swift`).
- **Snapshots and drawn pins.** An iOS snapshot draws the Apple Maps logo
  bottom left, about 20 pt tall (a macOS one does not), so drawn pins
  keep about 34 pt off the bottom. A snapshot of a rect with the image's
  aspect ratio projects exactly (it matched `snapshot.point(for:)` to
  1e-9 pt), so pins are placed in JS (`packages/core/src/geo/placeMap.ts`).
- **A street-level rect across 180° hangs** for 40–100 s, then fails with
  MKError 2. Never lay a map out across it (`placeMap.ts` draws none).
- **expo-maps' `onMarkerClick` fires on iOS 18 and later only.**
- **A search's region is a hint, not a filter**: "Cafe Meek" with a Vienna
  region returned a café 8,356 km away. A Mac with Location Services on
  biases results by its own location anyway, so the region mattered only
  for generic names.
- **MapKit answers a kind of place with a namesake**: "home" finds a
  home-goods store, "the office" a bar of that name, "Regen" a town in
  Bavaria; venues called exactly a common word exist ("Bett", "Arbeit",
  "Mittagspause"), and real venues often go by another name ("Luigi's"
  is "Da Luigi"). A hit is no proof without a name match and a distance
  check (architecture.md → Locations and maps). Probe real answers
  through the helper before building on them, about 1.4 s apart (MapKit
  throttles searches).
- **`MKLocalPointsOfInterestRequest` returns at most 50 results** and
  missed a known café: it cannot list a neighbourhood.
- **Addresses differ by source on iOS 26**: `MKAddress.fullAddress` of a
  place resolved from a completer row is postal lines joined by "\n" in
  the device's locale ("Wien, Österreich"), a search result's one line
  ("…, 1010 Vienna, Austria"). `oneLineAddress` in
  `packages/geo/src/client.ts` joins the lines for every consumer.
- **Concurrent completer calls race** (seen while probing, not chased).
- **Address-string heuristics keep breaking.** Each round of them drew
  three or more review findings (US ZIP codes, UK postcodes, "Toronto
  ON", "Vienna, Vienna"). The robust fix is MapKit's structured
  locality, region and country passed up from `GeoBridge.swift` (a native
  change): propose that before adding another heuristic.

## Speech (SpeechAnalyzer)

- **`SpeechDetector` is no endpointer**: on files it reported nothing at
  every sensitivity, and per its documentation its results "currently
  only support error handling". The app detects the end of a phrase
  itself (decisions.md → AI).
- **How fast words arrive**: DictationTranscriber writes word by word,
  0.2–0.6 s after each word; SpeechTranscriber's volatile results come in
  blocks of about 4 s (about 1 s with `.fastResults`), and in a crowd it
  keeps writing other voices after the phrase ended.
- **Custom language models are unproven**:
  `SFSpeechLanguageModel.prepareCustomLanguageModel` failed with error 1
  from a bare command-line binary, even for two phrases. Untried inside
  the helper or an app.
- **The iPhone's Mic Mode can be read, not set**:
  `AVCaptureDevice.preferredMicrophoneMode` reads the mode picked for the
  app (iOS 15+), no API sets it, and the simulator always reads
  "Standard".
- **The simulator has no `SpeechTranscriber`** (`isAvailable` is false):
  a transcription there fails with "Audio format is not supported", which
  means no engine, not a bad file. Dictation is checked on a device or
  on the Mac.

## On-device models

- **The Mac's and the iPhone's Apple models differ.** At temperature 0 a
  phrase got a short title on the Mac and the whole sentence on the
  iPhone, and the bench scored 49 on the Mac against 55 on an iPhone 16:
  a Mac score of Apple's model says nothing about the phone's. (The app's
  own GGUF answers alike on both: bench README.)
- **Apple's model can run for minutes.** On an iPhone, 6 of 70 phrases
  ran into `appleModel.ts`'s 60 s timeout (`GENERATE_TIMEOUT_MS`), which
  does not stop the generation: `@react-native-ai/apple` runs an
  uncancelled `Task` and the app passes no `maxTokens`. Each runaway ran
  70–80 s, and the next request waited 12–23 s behind it. On the Mac the
  model ran past its context on 10 of 40 find-a-time sentences, after
  about 170 s. A known gap while Apple's model still answers search,
  capture and the find-a-time fallback.
- **No warm-up prompt**: the first request to Apple's model must be a
  real one. A made-up warm-up failed on the simulator with
  `com.apple.SensitiveContentAnalysisML` error 15.
- **"Apple Intelligence unavailable" on a Mac**: decisions.md has the
  cause (Siri's language differs from the Mac's); `defaults read
  com.apple.assistant.backedup` shows the "Session Language" and when it
  changed.
- **No adapters for Apple's model**: Foundation Models adapters are not
  supported from OS 27 on (toolkit 26.0.0 was the last).
- **llama.rn's answers and calls** (`openModel.ts` handles the first):
  `completion().text` begins with the chat template's
  `<|im_start|>assistant`, and with no grammar `content` comes back as
  `<think>\n\n</think>\n\n{…}`, so cut to the first brace.
  `stopCompletion()` returns undefined, not a promise: it only sets a
  flag that the next completion's `rewind()` clears. `timings.cache_n`
  counts prompt plus generated tokens, so the reused prefix is
  `tokens_evaluated − prompt_n`. Two completions on one context throw
  "Context is busy".
- **Recurrent models read the whole prompt every call.** Qwen3.5 and LFM3
  are recurrent or hybrid: llama.cpp cannot roll their state back to a
  shared prefix, which cost 0.26 s of a 0.9 s phrase on an iPhone 16,
  where a transformer (Gemma 4 E2B) reused 92 % of the prompt. Untried:
  saving the state after the list of days.
- **Simulator timings are not a phone's**: the simulator has no Metal for
  llama.rn (`gpu: false`, "Metal is not supported in the simulator"), so
  the model runs on the CPU, several times slower than the Mac itself.
  Never quote them as a phone's.
- **Name a schema boolean for the rare case.** A required `understood`
  came back false from small models on phrases they had read; it became
  `nothingToSchedule`.

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
- **Async `safeStorage` before and after ready**:
  `isAsyncEncryptionAvailable` is true whenever the app is ready, even
  when the key cannot be read; before ready it is false and a decrypt
  rejects. Under `--use-mock-keychain` the async key provider keeps an
  in-memory keychain with a fresh key per launch, so a spec cannot
  relaunch on one profile and still read the tokens it stored.
- **A save sent as a window closes can be cut off**: `RpcServer`
  interrupts a client's requests in flight when its window is destroyed,
  so a save sent from `pagehide` or unload may never land. Save on blur,
  Enter or unmount, and hold a closing window with `beforeunload` until
  the save lands (`BirthdayReminderList.tsx`).
- **A reloaded page receives an old stream's batches**: `RpcClient`
  numbers requests from 0 on every page load, so a reload reuses an old
  request id. Main disconnects a page on a cross-document navigation
  (`rpcClientPages.ts`); note that `did-start-navigation` fires before
  `will-navigate` can refuse one.
- **A window shown with `showInactive` emits no `'show'` event.** Listen
  for `ready-to-show` too.
- **A `localStorage` change in one window reaches the other renderer
  asynchronously**: in e2e, `waitUntil` it, never one read.
- **A main-window atom read once can go stale** after the Settings window
  changed its setting, while a reopen reads fresh. Open, not fixed; other
  main-window reads of Settings-window settings may share it.
- **Faking `screencapture` in a test** needs a compiled binary of that
  name: a copied `/bin/sleep` gets killed at its new path. The real ⌘⇧3
  process lives only about 200 ms.
- **On a macOS 26 Mac a run from source respawns the helper every 5 s**:
  dyld refuses it (it is built for macOS 27, the floor). Unsupported.

## Lint and type checks

- **Lint refuses some React patterns** (the React Compiler's rules):
  `Date.now()` or `new Date()` inside a component, handlers included (put
  that logic in a store module read with `useSyncExternalStore`:
  `createPreviewStore` in `prPreview.ts`, `createSpikeStore`); `setState`
  in an effect, even a conditional one (`react(set-state-in-effect)`:
  adjust during render instead); reading or writing a ref during render
  (`react(refs)`).
- **`packages/ai` has no Node types**, being pure: anything that spawns
  the helper lives under `apps/desktop`.
- **TypeScript 7 has no JS compiler API**, so the tools built on it do
  not run: dependency-cruiser's tsc mode, typescript-eslint,
  `@effect/language-service` (it points at `@effect/tsgo`) and
  ts-prune-style tools. knip 6 (oxc), oxlint's type-aware mode (tsgolint)
  and `@effect/tsgo` work; dependency-cruiser runs only with `parser:
  'swc'` and `@swc/core`.
- **knip misses a member read through a dynamic import** (`const m =
  await import(…); m.X`) and calls it unused. Its vite-plus plugin also
  ignores `pack` entries and the env-gated `test.include` globs, which is
  why `knip.config.ts` names them.

## Shell and tooling

- **zsh does not word-split `$VAR`**: `env $COMMON …` passed one giant
  assignment, so `MODEL_BENCH` was not "1" and the bench skipped itself
  silently. `export` the variables instead.
- **zsh's `echo` expands `\n` inside JSON** before `jq` sees it. Use
  `printf '%s'` or a file.
- **macOS `xargs -I{}` runs nothing past 255 bytes** ("command line
  cannot be assembled"). Use `xargs -n 1` or a script.
- **A GitHub Actions `run:` without `shell:` is `bash -e` without
  pipefail**: `x | jq length` passes on an empty stdout, and a `grep`
  that matches nothing exits 1 and aborts the step. Use `set -o
  pipefail`, `jq -e` and `|| true`, and test workflow scripts under `bash
  -e`, not zsh.
- **Running repo TypeScript outside vitest**:
  `node_modules/.bin/jiti <script.ts>`. Plain Node fails on extensionless
  ESM imports in dependencies (jsonc-parser, `@calendar/core`).
- **A stale auto-installed peer**: `pnpm update -r --depth 99
  <package>` refreshes a transitive one a plain update leaves behind
  (`@react-native/metro-config` stayed at the old React Native minor).
- **`vp migrate` adds config to drop**: a `minimumReleaseAgeExclude` for
  the whole vite-plus toolchain, and `resolveDepSubpath` shims that
  assume tsdown before 0.23.
- **Babel 8 is a ceiling**: the worklets plugin throws under it, and pnpm
  hoists it over Metro's Babel 7.
- **An agent's file-editing tool can turn a `\uXXXX` escape into the
  character itself**, so a test string meant to spell out an invisible
  character holds it unseen: build such characters with
  `String.fromCodePoint`.
