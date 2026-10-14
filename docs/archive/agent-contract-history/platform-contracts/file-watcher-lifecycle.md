# Watcher engine, lifecycle, health, ignore overrides, packaging — evidence

Supports `docs/agents/platform-contracts.md` § "FILE WATCHER SERVICE LIFECYCLE".
Read before changing the watcher backend, a subscription cap, the ignore-pattern override, the git-inventory watcher, or the parcel asarUnpack glob. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
OS file watching is a PLATFORM capability beneath the assistant runtime —
Mastra/assistant code never owns watcher lifecycle and must not add
round-trip dependencies on this local latency path. Assistant tools consume
indexed state only.

- **One engine**: `@parcel/watcher` behind `@brainstrike/file-system/electron`
  (`parcel-backend.ts` + `parcel-watchers.ts`), explicit backend per OS
  (`fs-events` / `inotify` / `windows`). Unsupported platform, missing
  binding, malformed `BRAINSTRIKE_WATCHER_BACKEND`, subscribe timeout, and
  runtime backend failure all throw or surface typed health — never a
  fallback engine, never polling. `legacy` is a removed value that throws.
- **Silent host death is a real state, and health cannot see it (BST-1328)**:
  on some macOS hosts FSEventStream delivery stops while `subscribe()` still
  resolves and health still reports `healthy` — no error, no `overflow`, just
  nothing. The typed health channel covers the *announced* failures (a dropped
  -events backend error degrades to a root invalidation, log-once, subscription
  alive); it cannot cover this one, because nothing is announced. Tests
  discriminate it with `@brainstrike/file-system/testing/watcher-liveness`,
  which subscribes a RAW binding in a temp dir, touches a sentinel repeatedly,
  and only then runs an `fs.watch` control. Rule: **if the raw binding delivered
  nothing, no code above it can be blamed.** Note libuv's `fs.watch` rides the
  same FSEventStream subsystem on macOS, so "control also silent" is a more
  degraded host, not a different diagnosis. Production deliberately has no such
  canary today; adding one (self-touch a sentinel, expect the event) is the only
  detection that would catch this class in the field.
- **Lifecycle invariants**: one native subscription per owning renderer and
  resolved root; 10s subscribe timeout with late-resolution unsubscribe;
  disposers idempotent and safe at any time. Duplicate same-owner/root IPC
  registrations (renderer reload, StrictMode cleanup races, or legacy roots
  that resolve to the same realpath) receive distinct logical watchIds that
  share the existing native subscription. Events and health fan out to every
  live logical registration; unwatch removes only its registration and stops
  the native watcher after the last one leaves. `duplicateRegistrations` makes
  sharing visible in the in-memory telemetry. The per-owner cap counts native
  subscriptions, so an in-budget registration may share an existing root at the
  cap. A separate per-owner registration cap bounds retained watchIds and
  per-event IPC fan-out to twice the native-subscription cap. The
  main-process ownership registry also reaps on
  renderer destruction, crash, reload, root removal, and app shutdown
  (registrar disposer). A lifecycle generation rejects path resolution that
  finishes after its renderer context was reaped. No leaked subscription after
  any of these — extend the shared-registration and reaper tests when touching
  this.
- **Synthetic fixture boundary**: active dev inline-fixture roots are immutable
  in-memory trees, so their decorated `watchDirectory` returns an inert
  disposer instead of forwarding a fixture name to OS watcher IPC. The
  decorator remains capability-gated and delegates every foreign/real root to
  the wrapped watcher unchanged.
- **Typed health**: engines emit `starting|healthy|degraded|failed|stopped`
  exactly once per state change; `fs:watch-health` pushes are scoped to the
  owning WebContents with no root-path field on the wire; retry is
  manual-only (`fs:watch-retry`) with escalating 1s/5s/30s throttling and
  single-flight per watchId. Telemetry (`fs:watch-telemetry`) is in-memory
  counters only — deliberately NOT persisted, so it needs no factory-reset
  wiring; do not add persistence here without wiring factory reset.
- **Assistant file-read cursors**: the short `readWorkspaceFile` continuation
  registry is main-process, memory-only state. It survives renderer reloads,
  expires entries after one hour, and is cleared through the
  `read-workspace-file-cursors` factory-reset runtime. It must never move to
  durable storage, and unknown handles must never trigger a fresh-read fallback.
- **Per-subscription ignore override (BST-1112)**: `StartParcelWatchOptions.ignorePatterns`
  (threaded from `WatchDirectoryOptions.ignorePatterns`) lets a caller REPLACE
  `DEFAULT_IGNORE_PATTERNS` for its own subscription only — explicit overrides
  apply to both native ignore globs and the event guard, e.g. a
  main-owned git-metadata watcher that needs `.git/HEAD` events the default
  patterns would drop. `undefined` selects the default layers: the
  `fileFilter.shouldIgnorePath` guard PLUS (BST-1342) the background-indexing
  policy's unconditional excluded-path prefixes (`.claude/worktrees` and
  `.brainstrike/worktrees`),
  applied root-relatively and skipped entirely when the subscription root
  itself sits inside an excluded tree. `StartParcelWatchOptions` and concrete
  Electron `WatchDirectoryOptions` also expose
  `reportDefaultFilteredChanges`, default `false`. With that option false,
  `DEFAULT_IGNORE_PATTERNS` retain their pre-BST-1180 native globs and the
  callback receives no filtered-boundary evidence. Only `ipc-handlers.ts`'s
  MAIN-owned Explorer `fs:watch` dependency passes `true`; this broadens only
  `dist`, `build`, and `.DS_Store` while keeping `.git`, `node_modules`,
  `.pnpm-store`, `.next`, `.turbo`, plus the hard `.claude/worktrees` and
  `.brainstrike/worktrees` exclusions native. The JS guard emits root-relative boundaries without
  exposing detailed Explorer changes. Both watcher and renderer batching cap
  retained boundaries at 64 and surface explicit overflow. Tracked files in
  the retained high-cardinality trees require a future bounded Git-aware
  tracked-path watcher; this option must not broaden the recursive watcher or
  claim silent coverage.
  Notes Vault stays explicitly false. Git inventory keeps its explicit
  `ignorePatterns: []` and is marker-free. Reporting true plus ANY explicit
  override (including `[]`) throws before watcher setup — the configuration is
  ambiguous and never silently coerced. `[]` means "ignore nothing", never a
  silent fallback to defaults. Overrides
  cannot reach the desktop `fs:watch` IPC domain: `StartFileSystemWatch`
  takes no `ignorePatterns`, and that domain deduplicates native
  subscriptions on `(ownerId, resolvedPath)` only. Any future caller that
  threads an override through it MUST add the pattern set to
  `subscriptionKey`, or two registrations for the same root would silently
  share one filter set. Neither option is renderer/wire input; the shared
  Explorer refresh pipeline's broadening is fixed by its concrete main-process
  owner, so "same names, never broader" stays true (see
  `docs/agents/explorer-search-tapestry.md`).
- **Git-inventory watcher dead-on-failure (BST-1112)**: `git-inventory-watcher.ts`'s
  per-repo subscriptions (one per common dir, using the ignore override above)
  mark themselves dead on an `'errored'` signal — visible via typed state, never
  a silent no-op and never an auto-restart — and retry only when an explicit
  `sync()` call still lists that common dir. An `'overflow'` signal is
  different: it forces an IMMEDIATE invalidation (events may have been
  missed, so the whole repo's metadata is treated as stale) WITHOUT marking
  the watcher dead — it stays live and keeps batching normally afterward. The
  trailing debounce that batches interesting events also has a max-wait cap
  (`GIT_INVENTORY_WATCH_MAX_BATCH_MS`, 2000ms): sustained churn (a long
  `git checkout`/rebase/`gc`) would otherwise re-arm the debounce forever and
  starve invalidation indefinitely. Finally, `disposeAll()` is TERMINAL — once
  called, a `GitInventoryWatchers` instance never subscribes again, even if a
  later `sync()` lists a common dir; `git-inventory-service.ts`'s `stop()`
  drops the instance entirely, and a later `start()` always builds a fresh one
  rather than trying to resurrect a disposed instance.
- **Packaging**: asarUnpack for the parcel prebuilds is BINARY-ONLY
  (`**/node_modules/@parcel/**/*.node`) — whole-directory globs corrupt the
  asar under pnpm symlinks (see docs/archive/agent-contract-history/research/bst-568-parcel-watcher-spike.md).
  Packaged proof: `pnpm --filter @brainstrike/file-system test:packaged` in
  the Native Electron Package CI job.

Full event-pipeline invariants (batching, ignore rules, normalization,
consumers) live in `docs/agents/explorer-search-tapestry.md` ("EXPLORER TREE
LIVE REFRESH").
