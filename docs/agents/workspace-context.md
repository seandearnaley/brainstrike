# Workspace Context Features: Prompt Workbench, Instructions Injection, Slash Commands, Edit Checkpoints

> Extracted from AGENTS.md (2026-07-12). Read before changing the prompt library, AGENTS.md/CLAUDE.md injection, user-defined /commands, or the edit-checkpoint journal. Keep updated with the code.

## PROMPT WORKBENCH

The prompt library is a working surface inside the agent sidebar, not a standalone route:
Threads → Database → Prompts. Its source of truth is PGlite; never reintroduce a
localStorage-backed parallel store.

Ownership and flow:
- Persistence: migration 051 (`prompt_embedding_profiles`, `prompt_items`,
  `prompt_item_revisions`) + `PromptItemRepository`. Prompt edits use revision CAS and
  retain the previous revision. PGlite is the only prompt store; there is no localStorage
  compatibility path. Bootstrap performs the authoritative initial repository `list()`, and
  that database read remains fatal if it fails. Text filters treat SQL LIKE metacharacters
  (`%`, `_`, and `\`) as literals.
  Startup gating discriminates "database not ready yet" from "database failed": while
  `useDbInitializationStatus()` reports `idle`/`initializing` the connected manager renders the
  loading placeholder; the terminal "requires an initialized database" alert is reserved for a
  genuine init failure (status `error` with no handle), never a merely not-yet-ready DB. A
  successful `list()` that later throws is still fatal per the readiness error path above.
- Recall: prompt records own vectors under the dedicated singleton prompt profile — they
  are NOT fake files and MUST NOT be added to `embedding_sets`. Saved items use document
  embeddings; live composer context uses query embeddings. Vector failures surface in the
  workbench; there is no lexical fallback. Similarity search currently supports only cosine
  distance and fails closed when the configured profile declares `l2` or `ip`. The app-specific
  embedding queue loader MUST resolve before either operation so desktop/web worker URLs are
  registered explicitly.
  Indexing passes are serialized; overlapping bootstrap/save passes must never write the
  same revision concurrently. Connected refreshes remain authoritative and the interaction
  layer reconciles them into its local working set. Async save/list completions must merge
  against the latest committed authoritative snapshot, never the render that started them.
  Contextual query recall is enabled only while both the outer Explorer route and inner
  Prompts tab are visible; the force-mounted panel preserves UI state but must never run
  embedding inference while hidden. Search-embedder transitions serialize disposal and
  distinct-identity initialization (same-identity calls still deduplicate); WebGPU
  initialization/recovery fails closed while the document is hidden, and a hide event
  invalidates recovery even when it is awaiting disposal.
- Agent actions: `assistant-composer-command-store.ts` is a thread-keyed, in-memory FIFO.
  `AssistantUiPanelWrapper` bridges only that thread's head command into the real
  assistant-ui composer and acknowledges it after application. The store is registered with
  factory reset so queued commands and mirrored draft text never survive a live reset.
  Snippets/fragments append, prompts replace, and nothing auto-sends. Direct actions use a
  synchronous item/action in-flight guard so repeated activation cannot stage twice or create
  duplicate threads; prepared template submissions use the same guard and share the in-flight
  operation. Runnable prompts apply their configured model only after the model is
  enabled and its provider is available; unavailable targets fail
  visibly before mutating a thread. Their standard Mastra call settings are strictly validated
  and applied with `maxTokens` normalized to `maxOutputTokens`; unknown settings or conflicting
  aliases fail before mutation. On a provider switch, configured target-provider settings fill
  any missing per-thread target settings and build the target options; entries/options for the old
  provider remain available, but old-provider model settings must not leak into the new provider.
  On a same-provider change, explicit per-thread model settings win over provider defaults, and
  explicit settings stored on the prompt win over both.
  Workbench edits preserve stored rating and model settings until dedicated controls expose an
  explicit way to change them; changing the structured model key must not erase legacy settings.
  Rendered prompt text must be validated as non-whitespace before runtime selection, thread
  creation, composer staging, or usage writes. Composer context mirrors assistant-ui's authoritative
  state, including programmatic send/reset clears; never derive it only from textarea DOM events.
  New-thread actions create the durable thread with its final title atomically before
  activation/staging and wait for any in-flight initial resource load before creating. A ready
  thread resource must not be redundantly reloaded during this sequence or a stale `New Thread`
  snapshot can overwrite the title.
  Once persistence or composer staging succeeds, later indexing, list-refresh, or usage-count
  failures are secondary warnings: surface them explicitly, but never reject the completed
  primary action and invite a duplicate save/stage retry.
  Factory reset may tolerate only an explicitly missing legacy `prompt_items` relation. Any other
  prompt deletion failure aborts before close/VACUUM, restores reset retryability, and remains
  visible to the caller; never report a successful reset while prompt rows may remain.
- Composition: `connected-prompt-manager.tsx` owns DB/model/thread/vector wiring;
  `prompt-workbench-panel.tsx` remains the interaction layer; `prompt-template.ts` owns
  explicit `{{variable}}` resolution. The interaction layer must render a stored unavailable
  model as an explicit disabled selection (never visually pretend the current-thread model is
  selected), keep keyboard focus visible, and announce modal async failures locally. Root layout
  must load the connected manager through `connected-prompt-manager-lazy.tsx`; never pull the
  prompt/database/vector graph back into the initial app-shell bundle.

When changing this flow, update this section and the paired tests in `packages/db`,
`packages/app-shell`, `packages/ui`, and `packages/vector-management`.

---


## WORKSPACE INSTRUCTIONS CONTEXT (AGENTS.md / AGENT.md / CLAUDE.md)

Each mounted workspace root's top-level instructions file is auto-injected into
the assistant's system context as a PREPENDED `system` message every turn.
**Desktop-only** (needs fs + the assistant server; web has no injection path —
capability-gated, no `isElectron()` checks). Sibling to `referenced-files-context.ts`.

- **Injection** (`apps/desktop/src/assistant-server/workspace-instructions-context.ts`)
  wired at the SAME request boundary as `injectReferencedFilesContext`
  (`assistant-server.ts` `resolveInitialAgentStream`): referenced-files first,
  then workspace instructions LAST so the general conventions land FRONTMOST.
  Per root, first-match-wins over `AGENTS.md` → `AGENT.md` → `CLAUDE.md` at the
  root's top level, read through `readWorkspaceTextFile`'s existing
  containment/size/binary guards (NO new raw-fs read path). Headings are
  qualified by `root.displayName` (two roots that both ship `AGENTS.md` stay
  distinct). Budgets mirror referenced-files: `MAX_CONTEXT_FILE_CHARS` = 12_000
  per file, `MAX_CONTEXT_FILES_TOTAL_CHARS` = 48_000 aggregate — a HARD ceiling:
  a file that would OVERSHOOT the aggregate is counted as omitted (the injected
  total never exceeds 48_000), with an honest omission note. Truncation of an
  opted-in oversized file never splits a UTF-16 surrogate pair (a lone surrogate
  at the cut boundary is dropped). Skipped ENTIRELY for provider `'local'` (the
  built-in Gemma's whole context budget is 8,192 tokens — mirrors the
  personas/plan-mode local exclusions).
  - **Read-failure discrimination (no fabricated absence):** `findRootContextFile`
    returns a discriminated `{kind:'found'|'none'|'error'}`. Only a GENUINELY
    absent candidate (ENOENT) advances to the next name; a PRESENT-but-unreadable
    candidate (binary, over the 2 MB read cap, EACCES/EIO, containment violation,
    not-a-file) short-circuits to `'error'`. Injection LOGS a warn and omits that
    root (never a prompt note, never a silent "no file"); the Settings scan maps
    it to `status:'error'` → an "Unavailable" badge with the detail. A >2 MB
    `AGENTS.md` therefore shows as Unavailable, not silently dropped.
  - **Legacy fallback is fail-closed:** oversized opt-in is defined only for
    DB-backed roots. A DB-less legacy root (synthesized from `workspaceRootPath`,
    `rootId` = raw path) can never appear in the DB-driven Settings scan, so its
    opt-in is un-settable and its oversized file stays un-injected.

- **THRESHOLD-HYBRID policy** (product ruling — never a silent drop):
  - A file that FITS the per-file budget → auto-injected WHOLE by default (no note).
  - An OVERSIZED file (> per-file budget) → NOT injected by default; requires an
    explicit per-root opt-in. When opted in, injected TRUNCATED at the budget with
    an honest note. When NOT opted in, it is NOT injected and NO skip-note goes in
    the prompt — it is surfaced in the Settings UI as "detected but not injected
    (too large — N KB / ~M tokens)" instead.
  - A master enable toggle (default ON) covers the whole feature.
  - Dogfooding reality: this repo's own `AGENTS.md` was ~30KB (OVERSIZED) until
    the 2026-07-12 modernization split it into `docs/agents/*`; it now fits the
    per-file budget and auto-injects whole. The opt-in path remains the modal
    case for other large repos.

- **Preference** (`packages/preferences/src/stores/workspace-instructions-preferences-store.ts`) —
  persisted `{ masterEnabled: true, oversizedOptInByRootId: Record<rootId, boolean> }`
  keyed by durable DB `roots.id` (NEVER a raw path); only `true` opt-ins are
  stored. Reset via the direct-call seam in `factory-reset-helpers.ts` (mirrors
  `notification-preferences-store`, per the FACTORY RESET CONTRACT). The renderer
  attaches a plain-JSON snapshot to the request `runtimeData.workspaceInstructionsPreference`
  (contract type `WorkspaceInstructionsContextRequest`), gated to the desktop
  data-stream transport like `permissionPolicyRequest` — but this is a
  PREFERENCE, not a security boundary: the server reads it directly (no
  server-side re-derivation, unlike the permission gate). It is still parsed
  strictly — `readWorkspaceInstructionsPreference` DROPS a malformed field (a
  non-object preference, non-boolean `masterEnabled`, non-object opt-in map) with
  a warn rather than silently coercing it, then applies the fail-safe default
  (master ON, no oversized opt-ins).

- **Settings UI** (`packages/preferences/src/settings/system/workspace-instructions-settings-{section,category}.tsx`,
  registered in the DESKTOP page-content only) lists each mounted root's detected
  file with name, size, ~token estimate (chars/4, consistent with
  `countTokensHeuristic`), injection status, and the oversized opt-in toggle. It
  reads a per-root scan from `window.contextFiles.scan()` — IPC
  (`ipc-context-files{,-handlers}.ts`, channel `context-files:scan`, preload
  `contextFiles` bridge, capability-gated) whose main-process handler loads roots
  from the DB (`loadWorkspaceRootsFromDatabase`) and reuses the injection path's
  `findRootContextFile` (`workspace-instructions-scan.ts`) so status/oversized
  decisions are byte-identical to injection. A rejected `scan()` (DB unavailable,
  IPC failure) renders a DISTINCT, logged error state with a Retry button — NEVER
  the empty "no folders" state (which would falsely claim the workspace is empty).

- **Trust posture (accepted risk — conscious ruling):** injection is
  default-ON with NO per-root trust gate, unlike the Tool-Lifecycle Hooks
  feature (SHA-256 per-root approval). A mounted repo's instructions file
  becomes a high-authority `system` message automatically on mount — accepted
  because (a) content injection is already ungated here (`referenced-files-context.ts`),
  so this is not a new class of exposure, only default-on + automatic; and
  (b) the permission engine defaults mutation tools to `ask`, so injected text
  cannot silently drive edits/exec. The master toggle (and per-root oversized
  opt-in) are the user's off-switches. A future per-root acknowledgment of
  newly-detected files is a possible hardening, not a v1 requirement.

- **Deferred**: Mastra skills adoption (on-demand `createSkill()` per-root
  instructions — the architecturally better long-term fit, blocked on verifying
  its auto-added `skill`/`skill_search`/`skill_read` tools flow through the
  permission gate); web (no workspace-tool bridge); prompt caching.

When changing this flow, update this section and the paired tests
(`packages/preferences` store + settings-section + factory-reset tests;
`apps/desktop/src/assistant-server/__tests__/workspace-instructions-{context,scan}.test.ts`;
`apps/desktop/src/__tests__/ipc-context-files-handlers.test.ts`;
`packages/app-shell` request-builder test).

---

## USER-DEFINED SLASH COMMANDS

Prompt-template `/commands` authored as `*.md` files, projected into the SAME
composer "/" menu as the built-in app commands (they are a second *kind* of entry
in the existing `SlashCommand[]` flowing through `unstable_useSlashCommandAdapter`
— no new autocomplete). **Desktop-only by construction**: discovery reads disk in
the main process; web has no `window.userCommands` bridge and the hook returns
`[]` (capability-gated, never `isElectron()`).

- **Discovery (main):** `apps/desktop/src/ipc-user-commands*.ts` +
  `assistant-server/user-slash-commands-loader.ts` scan `*.md` in PRIORITY order,
  first-name-wins: (1) `<root>/.brainstrike/commands/` per mounted root, (2)
  `~/.brainstrike/commands/`, (3) `<root>/.claude/commands/` (Claude Code compat),
  (4) `~/.claude/commands/`. Scan HIGHEST priority first (the mastra-code-ui
  reference inverted this — do not copy that bug). Recursive with directory
  namespacing (`git/commit.md` → `git:commit`); cross-root collision keeps the
  first-mounted + warns once (mirrors use-file-mentions.ts's warn-once set). Roots
  resolve via `loadWorkspaceRootsFromDatabase` (DB `roots.id`, never a raw path);
  a DB failure still loads GLOBAL commands (logged, not silent). Fs is
  dependency-injected for unit tests.
  Command `.md` files are UNTRUSTED repo content, so the scan is BOUNDED
  (`user-slash-commands-loader.ts`): a per-file cap `MAX_USER_COMMAND_FILE_CHARS`
  (64K) skips oversized files with a visible warn-once (the real-disk `readFile`
  also descriptor-gates so main never blocking-reads a giant file), and a
  `MAX_USER_COMMANDS` (500) count cap ignores the rest with a warn — never a
  silent truncation or a hard error that kills the whole scan. The real-disk
  adapter opens the canonical mounted root as a native `SecureRoot` capability
  (`@brainstrike/secure-fs-native`). POSIX traversal uses component-by-component
  `openat(..., O_NOFOLLOW)`; Windows uses handle-relative `NtCreateFile` with
  `RootDirectory`, `OBJ_DONT_REPARSE`, and `FILE_OPEN_REPARSE_POINT`. Directory
  enumeration and bounded file reads stay relative to that pinned handle, so
  roots cannot borrow one another's trust or win a parent-path swap race. There
  is no path-based fallback; missing native support fails closed.
- **Frontmatter:** hand-rolled `---\nkey: value\n---` parser
  (`parseUserCommandFile` in packages/assistant-contract — NO YAML dep) for
  `name`/`description` only; unknown keys ignored, and Claude Code multiline-YAML
  continuation lines (`- item` list entries, `# comments`) are TOLERATED/ignored
  (so real `.claude/commands` files with `allowed-tools:` lists load); a leading
  UTF-8 BOM is stripped before fence detection; other malformed/unterminated
  frontmatter fails CLOSED (skipped + visible error, never a silent half-parse).
  No frontmatter = whole file is the template. The id is path-derived
  (namespaced); `name` becomes the label only; `description` is fuzzy-searched by
  the popover adapter + shown as the item tooltip.
- **Composer wiring (renderer):** `packages/app-shell/src/use-user-defined-slash-commands.ts`
  is merged into `useAssistantSlashCommands(threadId)` via `mergeSlashCommands`
  (app commands first; a user command whose id COLLIDES with an app command is
  DROPPED with a warn-once — the pinned adapter's `onExecute` is find-first, so a
  listed collision would run the app command from the user's row). `execute()`
  reads the LIVE composer draft (the app-shell mirror
  `assistant-composer-command-store.draftTextByThreadId`, fed by
  `onComposerTextChange`), extracts any args, expands, and WRITES the expansion
  back via `enqueue({ mode:'replace' })` — never auto-sends (the user sees + edits
  before sending). `removeOnExecute: true`, uniform with app commands. No active
  thread → a visible toast (not console-only). The list reloads on mount, on
  mounted-root change, and on window `visibilitychange` (so a file edited while
  backgrounded appears without a full reload).
- **Arguments — placeholder-fill (F1, pinned-library constraint):** the pinned
  `@assistant-ui/react` trigger popover closes at the FIRST whitespace after
  `/id` (`detectTrigger` returns null), so INLINE `/cmd args` capture is
  UNREACHABLE in the live flow — the arg string is always empty at selection.
  `expandUserCommandTemplate` therefore leaves any unfilled `$ARGUMENTS`/`$N`
  token LITERAL as a VISIBLE placeholder the user fills in the composer before
  sending (never a silent empty blank). Do NOT re-document inline args as working,
  and do NOT add send-time expansion (no-silent-expansion is binding).
- **Expansion (pure, renderer-safe, `expandUserCommandTemplate`):** a SINGLE
  tokenizing pass (F2) so substituted argument text is NEVER re-scanned — a
  `$100` or `$1` the user types as an argument survives verbatim. `$ARGUMENTS` =
  full args (else visible placeholder); `$1..$N` positional (absent → visible
  placeholder). Template `@path` tokens become `:file[basename]{name=encoded}`
  directives via `encodeFileMentionId`, so the existing referenced-files pipeline
  resolves/reads/budgets them for free (NO new file-reading); args INSIDE a
  template `@…$1` path are substituted BEFORE serialization so a `}` in the arg is
  percent-encoded and cannot truncate the directive into a different file. Root
  binding: a root-scoped command binds to its `sourceRootId`; a GLOBAL command
  binds to the single mounted root, else leaves the token literal for the `@`
  popover (NO silent guessing). User-supplied `@` argument text stays literal —
  only template `@paths` convert.
- **SECURITY HARD LINE:** there is NO shell (!\`command\`) expansion, gated or
  not, ever — it passes through as inert text (proofs in the contract, loader,
  and hook specs). Do not add it.

Paired tests: packages/assistant-contract/src/__tests__/user-slash-commands.test.ts,
apps/desktop/src/__tests__/assistant-server/user-slash-commands-loader.test.ts +
ipc-domains/ipc-user-commands-handlers.test.ts,
packages/app-shell/src/__tests__/use-user-defined-slash-commands.test.tsx +
use-assistant-slash-commands.test.ts (F4 merge), and the REAL-trigger
packages/ui/src/assistant-ui-panel/__tests__/slash-commands.behavior.test.tsx
(F1 placeholder-fill through the actual popover + adapter + write-back).
Explicitly DEFERRED: shell expansion (never), web (no workspace-tool bridge),
namespaced/categorized popover grouping, Mastra skills.

When changing this flow, update this section and the paired tests.

---

## EDIT CHECKPOINT JOURNAL (UNDO OF AGENT FILE EDITS)

Every agent file mutation records an undoable journal entry so a per-tool-card
**Revert** control (and a per-turn **Revert all edits** footer) can restore the
prior state. Desktop-only (web local chat has no assistant server / thread_runs
rows). Capability-gated, not `isElectron()`.

- **Capture point:** INSIDE the existing per-file `withFileLock` in all four
  `run*WorkspaceFile` functions (`assistant-tools.ts`), so the before-read →
  mutate → journal write is atomic against concurrent same-file edits.
  `toolCallId` comes from Mastra's 2nd `execute` arg
  (`context.agent.toolCallId`, verified against @mastra/core@1.50.0 dist types);
  identity (runId/threadId/resourceId) from `runtimeData.memory`. Capture is
  GATED on an active memory context and is NON-FATAL (debug on DB-absent, error
  on DB-throw) — the tool result contract is never changed.
- **Storage:** full BEFORE-content (capped at the 2 MB write limit), not a diff,
  so revert is an exact independent write and conflict detection is a hash
  compare. `after_hash`/`after_existed` are for conflict detection only (no
  after-content — redo is deferred). Binary/oversized before-state is recorded
  honestly via `capture_status` (`skipped_binary`/`skipped_too_large`) with null
  content — NEVER a truncated snapshot. `capture_status` enum:
  `ok`/`created`/`skipped_binary`/`skipped_too_large`/`expired`/`rename`; only
  `ok`/`created`/`rename` are revertible.
- **Table** `brainstrike_assistant_edit_checkpoints` (migration 051, registered in
  BOTH runners + bootstrapped byte-identically in app-shell's
  `assistant-memory-repository.ts`). NO FK (mirrors run_usage 046 — the numbered +
  drizzle migration paths run on a bare PGlite without the thread_runs/mastra_threads
  parents; an FK would break the full migration suite). Purged on factory reset
  (`db-ipc.ts` `OptionalRelationTable`).
- **Retention** (`edit-checkpoint-journal.ts`, strict-parsed env, no silent
  fallback): `BRAINSTRIKE_CHECKPOINT_CONTENT_BUDGET_BYTES` (32 MB) NULLs the oldest
  non-reverted before-content to `expired`; `BRAINSTRIKE_CHECKPOINT_MAX_ROWS`
  (500) hard-deletes the oldest rows. Pruned after every insert.
- **LIST = renderer-direct DB (Path A):** `listThreadCheckpoints(threadId)` on the
  PGlite repository, across ALL runs (revertible after reload). `before_content`
  is NEVER selected — it stays in main.
- **REVERT = IPC to main (Path B):** `window.assistantCheckpoints.revertEntry/revertRun`
  → `assistant-checkpoint:revert-*` → `edit-checkpoint-revert.ts`. Resolves the
  stored `root_id` via the roots table and REFUSES a disconnected root (never
  guesses); detects on-disk conflicts (hash compare, `force` overrides); applies
  the per-op inverse (restore-write / delete-created / recreate-deleted /
  rename-back) under the file lock; reuses the write tools' non-fatal reindex
  seams; stamps `reverted_at` (idempotent). Reverts are NOT re-journaled.
  `revertRun(runId)` reverts every non-reverted entry of a run in reverse apply
  order and is HONEST about partial success — one conflicting file returns an
  `ok:false conflict` outcome without aborting the rest.
- **UI = per-entry button + per-turn footer.** The per-tool-card
  `CheckpointRevertButton` (`tool-fallback.tsx`, keyed by `toolCallId`) undoes one
  edit. The per-turn `CheckpointTurnRevert` footer (`checkpoint-turn-revert.tsx`,
  its own module for the assistant-panel line budget) mounts on every
  `AssistantMessage`: it reads the turn's tool-call parts from assistant-ui
  message state (`useAuiState(state => state.message.parts)` — same discriminant
  live and on reload) and resolves the true revert scope via `selectTurnRevertScope`
  against ALL of the thread's journal entries. Because the default `edit:ask`
  policy splits ONE run across several live assistant messages (each approval
  resume appends a new message sharing the runId) while `revertRun(runId)` reverts
  the WHOLE run, the footer is **run-scoped**: it renders once per run — on the
  run's LAST leg (the message holding the run's last-applied revertible tool call,
  its "anchor") — and its count is the run's full revertible-entry total
  (including `toolCallId:null` entries that never render but still revert), so the
  shown count always equals what reverts. It reverts each owned run **sequentially,
  newest first** (a shared file edited by two runs must revert in reverse order —
  `Promise.all` can't guarantee it), through the SAME `revertRun` bridge.
  Both controls mirror one UX contract — confirm → revert, on-disk conflict →
  "Revert anyway" (force), idempotent after success (reverted entries drop out on
  refetch). The turn footer additionally surfaces a **visible failure state**: an
  unexpected executor throw or an all-fail non-conflict result (e.g. a
  disconnected-root `not_revertible`, whose actionable message is shown) sets a
  `failed` phase with a retry — never left stuck disabled in `reverting`, never a
  silent return to idle. Pure capability gating: `null` on web / for turns whose
  message owns no revertible run, never a disabled stub.
- **Live-turn availability + reconciliation.** The footer must appear for the
  turn that JUST ran (its headline "undo what the agent just did" scenario). The
  journal rows are written in main DURING tool execution — after the thread-open
  read — so `useEditCheckpoints` exposes a `refetch` the wrapper composes into the
  run-lifecycle `onRunFinished`/`onRunFailed` seam (no polling); a monotonic
  generation guard drops a stale refetch that resolves after a newer one (mid-revert
  thread switch). A `revertRun` that unexpectedly rejects (partial on-disk revert)
  refetches BEFORE rethrowing so the per-entry/turn controls reconcile.
- **Key files:** `edit-checkpoint-{journal,capture,revert,errors}.ts` +
  `ipc-domains/assistant-checkpoint-*.ts` (desktop),
  `edit-checkpoint-context.tsx` (context + `selectTurnRevertScope` /
  `useCheckpointTurnRevert`) + `tool-fallback.tsx` + `checkpoint-turn-revert.tsx`
  (ui), `use-edit-checkpoints.ts` (app-shell — `revertEntry`/`revertRun` wired to
  the bridge with refetch-on-success + refetch-before-rethrow, plus the run-completion
  `refetch`) + `assistant-ui-panel-wrapper.tsx` (composes refetch into the run
  callbacks), `packages/assistant-contract/src/edit-checkpoints.ts`.

When changing this flow, update this section and the paired tests.

---

## READ-BEFORE-WRITE STALENESS GUARD (LOST-UPDATE PROTECTION)

The compare layer of core 1.51's workspace `requireReadBeforeWrite` contract
(report R8), adopted **compare-only** — a settled scoping decision, do not
widen to core's stricter "refuse any overwrite without a prior read" layer
without revisiting the test surface that legitimately writes unread files.

- **Tracker:** `packages/agent/src/tools/file-read-state.ts` — pure in-memory
  map of `scope|canonicalAbsolutePath → last observed mtimeMs`, where scope is
  `runtimeData.memory.threadId` (sentinel `__no-thread__` without one). One
  thread's observations never vouch for another's. Ephemeral main-process run
  state (like the sibling `file-write-lock` map), NOT persistence — not a
  factory-reset surface. Bounded by LRU-on-write eviction
  (`FILE_READ_STATE_MAX_ENTRIES = 4096`), never unbounded.
- **Observations recorded:** content-bearing reads (`readWorkspaceFile`), the
  assistant's own successful `write`/`stringReplace` (post-write stat INSIDE
  the same lock — consecutive same-thread writes never self-trip), and a
  rename's destination. `delete`/rename-source FORGET their record so a later
  re-creation is new, not compared against a ghost. `findWorkspaceSymbol`
  deliberately does NOT record (snippets ≠ knowing the file).
- **Compare points (all INSIDE the per-file `withFileLock` critical section):**
  `write` stats the target before mutating; `stringReplace` compares against
  its own fresh under-lock read's mtime; `rename` compares the source's lstat.
  Mismatch → typed actionable refusal ("changed on disk since you last read
  it… re-read and retry") — same refuse-rather-than-guess posture as the
  string-replace ambiguity error. The model's recovery is always: re-read
  (records the fresh mtime), retry.
- **Exemptions:** files this scope never observed (compare-only contract);
  brand-new files (nothing recorded); an observed file that VANISHED from disk
  (recreating it loses nothing — the stale record is dropped and the write
  proceeds).
- **Identity + ordering rules (review-hardened):** the read tool's read+record
  runs INSIDE the same per-file lock as the writes, so a racing read can never
  clobber a fresh own-write observation back to a stale value. Reads record
  under the realpath'd TARGET, so rename compares a symlink source via the
  target's key + stat (a dangling link has nothing to compare); a symlink
  rename moves only the link, so the target's observation stays valid and no
  destination record is made.
- **Accepted residual risks:** mtimeMs equality can miss a sub-timestamp-
  granularity external edit on coarse-mtime filesystems (FAT/some network
  mounts — APFS/ext4/NTFS are fine); and a checkpoint REVERT writes outside
  these tools, so a thread's next edit to a reverted file may hit one refusal
  (arguably correct — its view IS stale) and recovers with the standard
  re-read. Both are deliberate: no polling, no fs watchers, one bounded
  refusal worst-case.
- **Paired tests:** `packages/agent/src/__tests__/file-read-state.spec.ts`
  (state semantics) + the `read-before-write staleness guard` describe block in
  `apps/desktop/src/__tests__/assistant-server/assistant-tools.integration.test.ts`
  (real-fs refuse/recover behavior, `utimes`-forced external edits).

When changing this flow, update this section and the paired tests.

---


