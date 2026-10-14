# Run notification layers — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT RUN NOTIFICATIONS". Read this before proposing to change the preference store, the dispatch gate, the trigger sources, or the forge observation path.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

OS-level `Notification` API alerts for three run-lifecycle events plus two
forge observations — run finished, run failed (including watchdog stalls
surfacing as `run.failed`), tool approval required, pull request opened, and
pull request checks finished — fired only while the app is NOT the user's
active focus. One code path for Electron renderer AND web: the standard web
`Notification` constructor, no Electron `Notification` module, no new IPC.

Layers:
1. **Preferences** (`packages/app-state/src/stores/notification-preferences-store.ts`) —
   persisted master toggle (`masterEnabled`, default OFF) + per-event toggles
   (`events.{runFinished,runFailed,toolApprovalRequired,prOpened,prChecks}`,
   default ON).
   PERSISTED via the same `createBrowserJsonStorage` pattern as sibling
   stores. Registered in the factory-reset pipeline: like
   `permission-policy-store`, `resetNotificationPreferencesStoreToDefaults`
   is called directly from `factory-reset-helpers.ts`'s `clearBrowserStorage`
   (not `registerFactoryResetSessionStore` — that seam is for stores OUTSIDE
   the `preferences` package) so the live in-memory toggle never survives a
   reset that does not reload the page (web path).
2. **Decision + dispatch** (`packages/app-state/src/notifications/`) —
   `should-notify.ts` is a PURE gate (`shouldNotify`): master on, event on,
   `Notification.permission === 'granted'`, and the app is not active (the
   `appActive` boolean, the shared `isAppActive()` reading from
   `@brainstrike/hooks`: visible AND focused, where focus is the native window's
   on desktop and `document.hasFocus()` on web; BST-1864), evaluated AT EVENT
   TIME. `notification-permission.ts` wraps
   `Notification.permission`/`requestPermission()` — permission is requested
   ONLY from the Settings toggle-on click (never on load), and the store
   never persists `masterEnabled: true` when the browser denies or has not
   granted permission. `run-notification-dispatcher.ts`
   (`createRunNotificationDispatcher`) evaluates the gate and constructs a
   `Notification` with privacy-safe copy. Coalescing key is `runId:kind` for
   run finished/failed and `runId:kind:toolCallId` for `toolApprovalRequired`,
   so a run that suspends for more than one distinct approval still alerts on
   each. The input is a discriminated union: run events carry only
   `runId`/`kind`/an optional `threadTitle` (plus a REQUIRED `toolCallId` on
   the approval variant), while forge observations carry only
   `observationKey`/`kind`/`prNumber`/an optional settled checks outcome and
   thread title. Neither variant carries message content or tool args, and the
   dispatcher wires `onclick` to `window.focus()`.
3. **Settings UI** (`packages/settings-ui/src/settings/system/notification-settings-section.tsx`,
   registered via `createNotificationSettingsCategory()` from its own
   `notification-settings-category.tsx` — a non-component module, kept out of
   `settings-page-content.tsx` so Fast Refresh preserves `SettingsPageContent`
   state; imported in both `apps/web/src/app/settings/page-content.tsx` and
   `apps/desktop/src/renderer/components/settings/page-content.tsx`) —
   master + per-event toggles, surfaces a "blocked by your browser/OS"
   message when permission is denied/unsupported.
4. **Trigger source** (`packages/assistant-ui/src/run-lifecycle-notifications.ts`) —
   pure selectors (`selectTerminalRunEvents`, `selectOpenToolApprovalRequests`)
   scan thread messages for `run.finished`/`run.failed`
   (`ASSISTANT_RUN_EVENT_DATA_NAME`) and tool-approval-required
   (`TOOL_APPROVAL_DATA_NAME`) data parts. `useRunLifecycleNotifications`
   reports each NEW one exactly once (deduped via refs) through THREE new
   optional `AssistantUiPanelProps` callbacks — and DEFERS seeding its "seen"
   baseline until `state.thread.isLoading` is false, so async history
   hydration (opening/reloading an existing thread first renders an empty
   snapshot) seeds the replayed history without firing stale notifications
   (`onRunFinished`/`onRunFailed`/`onToolApprovalRequired`) that thread the
   SAME 5 layers as `onUsage` (`AssistantUiPanel` → `LocalRuntimeChat`/
   `DataStreamRuntimeChat` → `ChatThreadUI`, which mounts
   `RunLifecycleNotificationBridge`). This package NEVER touches
   `window.Notification` or the preferences store — it only reports raw
   events, mirroring the `onUsage` seam.
5. **Composition** (`packages/app-shell/src/use-assistant-run-notifications.ts`,
   wired into `assistant-ui-panel-wrapper.tsx`) — the ONLY layer that reads
   live `Notification.permission` and owns a
   `createRunNotificationDispatcher` instance, and it feeds the gate
   `isAppActive()` (never `document.hasFocus()`, which reads false while the
   browser pane or DevTools holds keyboard focus: BST-1864) so the unseen-badge
   rule and the alert cannot disagree (stable for the panel's
   lifetime, so per-run coalescing is meaningful). Hosted turns coalesce on
   the wire `runId`; web local-runtime events carry no `runId`
   (`createLocalRunEvent` assigns only a per-event `id`), so the hook falls
   back to `event.id` — a stable, unique key, never a fabricated runId that
   could collide across runs. Desktop's hidden
   embedding/llm hosts (`embedding-host-app.tsx`, `llm-host-app.tsx`) never
   import `AssistantUiPanel` at all, so they structurally can never notify —
   this hook only ever runs inside the visible assistant surface.
6. **Forge trigger source** (`packages/app-shell/src/hooks/use-forge-run-events.ts`) —
   `forge:prUpdated` pushes from the main-process ForgeService. Not a stream
   scan: a forge observation never appears in the message stream. Coalesced on
   `<repoCommonDir>\0<branch>\0<headSha>:<kind>` (the `\0` separator matches
   `forge-service.ts`'s own `cacheKey` convention), gated per thread by
   `metadata.forgePrWatch !== false`.
   The branch lookup this trigger source matches pushes against
   (`useThreadBranchByRootPath`, activated on demand — see that hook's doc)
   starts EMPTY and only resolves asynchronously; a push that arrives before
   the first resolution is BUFFERED (a ref queue, deduped by
   `<observationKey>\0<transition>`) rather than treated as a non-match, and
   drained once the lookup reports `loaded` — see `ForgeBranchLookup` and
   `isLookupReady` in `use-forge-run-events.ts` (BST-1391 M2). This closes the
   "the very first push is lost" gap; it does not add a live-refresh path for
   an ALREADY-OPEN thread — see the reload-visibility note below.
   RELOAD-VISIBILITY LIMITATION (BST-1391 M4): the appended `pr.*` row is
   durable in `brainstrike_assistant_run_events` the moment
   `appendThreadRunEvent` resolves, but the assistant-run-timeline UI renders
   from assistant-ui DATA PARTS on the message stream, not from a live query
   against that table — `listThreadRunEvents` is read ONLY at thread-history
   HYDRATION time (`createAssistantThreadHistoryAdapter`, on thread
   open/reload), which is what turns persisted run events into synthetic data
   parts. No existing seam re-hydrates an already-open thread's timeline
   mid-session. This is NOT the timeline lagging behind a live
   `thread.metadata.forgePrUrl` — `useAssistantThreadStore` is
   REFRESH-DRIVEN (`refreshResourceThreads`), not a live query, so
   `forgePrUrl` does not update live either. The PR chip and thread-row pill
   stay fresh through their OWN independent live sources instead:
   `use-thread-forge-pr.ts` reads `window.forge` directly (the chip), and
   `use-forge-pr-cache.ts` reads a PGlite live query over
   `brainstrike_forge_prs` (the pill, Task 5) — neither reads
   `thread.metadata` or `listThreadRunEvents`.
   `pr.*` row therefore does not appear in an OPEN thread's timeline until
   that thread is reopened or the app reloads. Inventing a live-refresh path
   for this is future work, not this task's — see Task 7's CDT checklist for
   how this is verified rather than assumed.

When changing this flow, update this section and the paired tests
(`packages/app-state/src/__tests__/notification-*.test.ts(x)`,
`packages/assistant-ui/src/__tests__/run-lifecycle-notifications.test.ts`,
`packages/assistant-ui/src/__tests__/run-lifecycle-notifications-hydration.test.tsx`,
`packages/app-shell/src/__tests__/use-assistant-run-notifications.test.ts`,
`packages/app-shell/src/__tests__/use-forge-run-events.test.ts`).

