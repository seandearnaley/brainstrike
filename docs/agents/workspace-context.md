# Workspace Context Features: Prompt Workbench, Instructions Injection, Slash Commands, Agent Skills, Edit Checkpoints, Root Identity (Main vs Focused)

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
  Workbench edits preserve stored ratings and expose the five canonical runtime model settings
  (`temperature`, `topP`, `maxOutputTokens`, `frequencyPenalty`, `presencePenalty`) in a collapsed
  Advanced section. Saving replaces only those editable keys, preserves other stored settings,
  and canonicalizes legacy `maxTokens` to `maxOutputTokens`; changing the structured model key must
  not erase model settings.
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
  (`packages/assistant-service/src/stream-init.ts` `resolveInitialAgentStream`): referenced-files first,
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

- **Preference** (`packages/app-state/src/stores/workspace-instructions-preferences-store.ts`) —
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

- **Settings UI** (`packages/settings-ui/src/settings/system/workspace-instructions-settings-{section,category}.tsx`,
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

- **Deferred**: web (no workspace-tool bridge); prompt caching. (Mastra skills
  adoption LANDED as its own feature — see AGENT SKILLS below; the old blocker
  was resolved by wiring the skill tools through the pipeline rather than the
  Agent-level auto-add.)

When changing this flow, update this section and the paired tests
(`packages/app-state` store + factory-reset tests and `packages/settings-ui` settings-section tests;
`apps/desktop/src/assistant-server/__tests__/workspace-instructions-{context,scan}.test.ts`;
`apps/desktop/src/__tests__/ipc-context-files-handlers.test.ts`;
`packages/app-shell` request-builder test).

---

## SELF-IMPROVEMENT SIGNAL INJECTION (BST-1241)

Desktop can prepend a compact summary of the previous 24 hours' wasteful tool
behavior to each fresh assistant run. This is an explicit persisted opt-in and
defaults OFF. The renderer attaches `{ enabled }` as plain JSON; the server
strictly parses it with malformed input failing safe to OFF.

- **SQL ownership:** injection executes the app-owned
  `SELF_IMPROVEMENT_SIGNAL_SQL` constant, never a workspace-scanned lens. A
  mounted repository can shadow `.brainstrike/lenses/self-improvement-signal.sql`;
  executing that untrusted copy automatically would let repository-authored SQL
  shape a system message. The parity test parses the shipped repository lens and
  pins its SQL body byte-equal to the app-owned constant so the reviewed query
  and injection query cannot drift.
- **Position and scope:** `resolveInitialAgentStream` applies the injector only
  on the fresh-generation path, between explicit skill activation and workspace
  instructions. Because every injector prepends, final context order is
  workspace instructions → self-improvement signal → activated skills →
  referenced files → conversation. Approval and resume legs retain their early
  returns and never re-inject it. Provider `local` is excluded to protect its
  small context budget.
- **Untrusted DATA hardening (distinct from SQL ownership):** telemetry
  `tool_id` is persisted VERBATIM from the original tool name, and MCP servers
  choose arbitrary strings — so the query's *rows* are an untrusted channel
  even though its *SQL* is app-owned. Rendering restricts each id to
  `[A-Za-z0-9_.:-]` (rest → `_`) capped at 40 chars, so a hostile name can
  neither smuggle newline/instruction-shaped text into the system message nor
  inflate the prompt. Worst-case whole-block size is structural (id cap ×
  top-5), pinned < 750 chars by test — there is no runtime truncation path.
- **Latency + prompt-cache posture:** the 24h window anchors to the top of the
  hour and the parsed rows are memoized per hour-key in main. One sandboxed
  query per hour per process (the admit `EXPLAIN` + execute pair stays off the
  per-run path of the single-connection PGlite, where `statement_timeout` is
  inert), and the rendered block is byte-stable within the hour, so the
  provider's cached prompt prefix (BST-587 invariant) is invalidated at most
  hourly. Failures are NOT memoized — the next run retries; an empty no-waste
  hour IS memoized so it cannot re-query per run.
- **Failure posture:** query failure, malformed rows, or an unexpected column
  contract logs a warning and injects nothing; zero qualifying waste logs at
  debug. It never injects stale, fabricated, or guessed text, and every no-op
  preserves the original message-array identity.
- **Measurement/removal protocol:** compare equivalent before/after windows with
  both the `run-outcome-tool-correlation` and `self-improvement-signal` lenses,
  following the comparable-window method in
  [`docs/tool-token-efficiency-2026-08-07/BASELINE.md`](../tool-token-efficiency-2026-08-07/BASELINE.md).
  After a meaningful sample, remove the feature if truncation and zero-match
  rates do not improve.

The companion experiment-enrollment preference (BST-1251, phase 2B) rides the
same renderer seam: a persisted `{ experimentId, variant }` pair (defaults
null = un-enrolled, factory-reset to null) attached as
`experimentAssignment` only when BOTH fields are set — the contract requires
the pair jointly, and the server strictly parses it onto the run's treatment
row (see `docs/agents/assistant-persistence.md`). Enrollment is attribution
metadata only; it never changes runtime behavior.

Paired tests: `apps/desktop/src/__tests__/assistant-server/self-improvement-signal-context.test.ts`
(preference, provider, query/column/row failure posture, exact prompt, size, and
SQL parity),
`packages/app-state/src/__tests__/factory-reset-self-improvement-signal-preferences.test.ts`,
`packages/app-state/src/__tests__/experiment-assignment-preferences-store.test.ts`,
`packages/app-state/src/__tests__/factory-reset-experiment-assignment.test.ts`,
`packages/settings-ui/src/__tests__/self-improvement-signal-settings-section.test.tsx`,
`packages/settings-ui/src/__tests__/experiment-assignment-settings-section.test.tsx`,
and `packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-runtime.test.ts`.

---

## `.brainstrike/` SCAN CONVENTIONS — the family

Three features scan per-root + `~/.brainstrike/` config directories, and any
fourth MUST reuse one of these two shapes rather than inventing a third:

| Feature | Dir | Loader | Shape |
| --- | --- | --- | --- |
| /commands | `commands/` (+ `.claude/` compat tiers) | `user-slash-commands-loader.ts` | recursive, `:`-namespaced, invalid dropped w/ log |
| personas | `agents/` | `user-personas-loader.ts` | flat, `entries` + visible invalid, first-id-wins |
| lenses (BST-921) | `lenses/` | `lens-loader.ts` | mirrors personas exactly; grammar in `assistant-contract/src/lenses.ts`; surfaced via `querySelf` `listLenses`/`lens` (see `docs/agents/agent-self-query.md` § Lenses) |

### Four rules every flat-scan loader must follow (BST-936)

Learned the hard way: the lens loader mirrored the persona loader faithfully
and inherited three real defects with it. Both now follow these; a fourth
loader must too, and `/commands` should adopt them if it ever grows an
authoring UI.

1. **Reserve the id from the FILENAME, before reading or parsing** — through
   ONE exported contract function shared by the loader and the parser, so the
   reserved key and the real id cannot drift. Without pre-parse reservation, a
   BROKEN project-tier file silently hands its name to a same-named global
   file carrying different behaviour — the worst failure mode available to a
   config system.
   **Reserve through the FULL id gate, not half of it.** Personas use
   `resolveUserPersonaId` (derivation + built-in collision), NOT bare
   `deriveUserPersonaId`: a name owned by a built-in can never load in any
   tier, so it must not reserve — otherwise the second same-named file is
   mislabelled "shadowed" when the honest answer is "a built-in owns this
   name", which both files deserve to be told. Lenses use `deriveLensId`
   (they have no built-in namespace). A filename that derives no valid id
   reserves nothing.
2. **The count cap counts ENTRIES (valid + invalid), not accepted items** —
   otherwise a directory of malformed files extends the scan across every
   mounted root instead of consuming the bound. Because that makes the cap
   *destructive* (an earlier root can exhaust the budget before a later tier
   is read at all), exhausting it is REPORTED per directory, not just logged.
3. **The directory-listing bound is NOT the item cap.** `listDir`'s
   `maxEntries` counts every directory entry (READMEs, subdirs, backups), so
   deriving it from the cap lets junk evict real files from the listing before
   they are read. Both use `cap * 2 + 1`. Every partially-scanned directory —
   whether the listing truncated or the cap was exhausted first — lands in
   `incompleteDirs` with its reason, so "my file is missing" always has a
   visible cause. In the UI these read as AMBER warnings, never destructive
   red: red is reserved for "you must fix a file".
4. **Suppressed duplicates are VISIBLE, as `status: 'shadowed'` ENTRIES**
   carrying `shadowedBy: { absPath, sourceRootId? }` — naming the file that
   WON, because "which copy is live?" is the author's actual question. This is
   `skill-scan.ts`'s existing shape (`packages/agent/src/skills/`), adopted
   deliberately rather than inventing a third: the skills panel already says
   *"Shadowed by … in `<absPath>` — this copy is inactive."* and both other
   panels now match it. A shadowed file is its own state, NOT an error —
   precedence is not an authoring mistake — so it renders muted, and
   `listLenses` prints a `SHADOWED` line naming the winner.

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
packages/assistant-ui/src/__tests__/slash-commands.behavior.test.tsx
(F1 placeholder-fill through the actual popover + adapter + write-back).
Explicitly DEFERRED: shell expansion (never), web (no workspace-tool bridge),
namespaced/categorized popover grouping. (Mastra skills LANDED — see AGENT
SKILLS below; user-invocable skills are a THIRD slash-entry kind merged after
user commands. MCP server prompts are a FOURTH kind — see below.)

### MCP SERVER PROMPTS — the fourth slash-entry kind (BST-1592)

Prompts published by connected MCP servers, merged LAST into the same
`SlashCommand[]`. Desktop-only by construction (`resolveMcpPromptBridge()` needs
the visible-UI preload's `window.mcp` content + status members; web returns
`[]`, while a PARTIAL bridge is a defect the always-mounted host reports out
loud). Ids are `mcp:<configuredServerId>:<promptName>` with `:` and `\` escaped
in both components (both may contain the delimiter, and a non-injective id would
drop a valid prompt), and labels are `<title> · <configuredServerId>` with the
raw values, because two servers may expose the same prompt name and the user
must see WHOSE prompt they are staging.

Because the pinned popover cannot capture inline args (the F1 constraint above),
an argument-taking prompt opens a MODAL (`packages/app-shell/src/mcp-prompts/`)
whose inputs are backed by `completion/complete` (`ref/prompt`); an
argument-less prompt stages immediately. Either way `prompts/get` runs only on
that explicit action, and the result is written to the composer DRAFT — never
auto-sent, never eager model context. Both the pending selection and the live
draft are re-checked AFTER the await: a dismissed dialog stages nothing, and a
draft the user has edited meanwhile is APPENDED to rather than replaced. Full contract, failure taxonomy, and
packaged proof: `docs/agents/assistant-providers.md` (BST-1592).

When changing this flow, update this section and the paired tests.

---

## AGENT SKILLS (SKILL.md — agentskills.io spec)

Skills teach the assistant specialized workflows via progressive disclosure:
name+description always in context, full SKILL.md instructions loaded on
demand, bundled references/scripts/assets read as needed. Built on Mastra's
canonical skills surface — the exported `WorkspaceSkills` INTERFACE,
`createSkillTools` (`skill`/`skill_read`/`skill_search`), `SkillsProcessor`,
and `formatSkillActivation` — over a brainstrike-owned engine, because
Mastra's own `WorkspaceSkillsImpl`/`LocalSkillSource` are (a) not public
exports and (b) unbounded plain-fs readers. **Desktop-only by construction**
(SecureRoot fs + the assistant server); web constructs no bridge/engine
(capability-gated, never `isElectron()`).

- **PIPELINE RULING (the old adoption blocker — do not relitigate):** the
  skill tools are NEVER attached via Mastra's Agent-level `skills:` option —
  its auto-added tools land AFTER `new Agent` and would bypass
  guards→hooks→plan-mode→permission. Instead `createMastraAgentRuntime` folds
  `createAssistantSkillTools(workspaceSkills)` into the LOCAL tool map BEFORE
  `sanitizeTools` (`mergeSkillToolsIntoLocalTools`, agent-runtime.ts), so they
  traverse the full pipeline like every native tool. They are registered in
  the contract registries under Mastra's canonical UNNAMESPACED ids with
  `riskCategory:'read'` (free under the default policy; kept in plan mode).
  Bundled skill scripts execute only through the deferred desktop
  `brainstrike.runSkillScript` tool. Its typed input requires the activated
  winning skill name, canonical `scripts/...` path, `node|python3|bash`
  runtime, structured argv, and an explicit mounted root plus root-relative
  cwd. The trusted scan engine rejects absolute/traversal paths, disabled or
  shadowed skills, missing/list-unregistered scripts, runtime-extension
  mismatches, and unmatched Claude `allowed-tools: Bash(...)` rules. A
  workspace-local skill is pinned to its owning durable root; a global skill
  may target any explicitly selected mounted root. Execution uses direct argv
  spawning (never a shell command string), the shared bounded-output/process
  tree lifecycle, and the normal `execute:ask` approval gate. Activation
  guidance sends project mutation through native workspace tools and forbids
  shell heredocs; declining an optional script continues through those native
  tools rather than retrying the approval. Because `runSkillScript` is
  DEFERRED on hosted discovery runs, the activation guidance also carries its
  own recovery path — load it with `load_tool` by exact name when available,
  callable on the next step of the same response — otherwise a model that
  checks its visible tools concludes the named tool does not exist and works
  around via `executeCommand`, bypassing this whole policy layer (2026-08-23
  field failure; see the
  discovery-coverage rule in `docs/agents/assistant-providers.md`). The
  guidance's space is RESERVED inside the activation budget
  (`withBoundedActivationAndGuidance`): bounding used to run AFTER the append,
  so any over-budget SKILL.md — the script-heavy kind that needs the recovery
  path most — had the entire guidance block truncated away.
  Live-loop proof: packages/agent/src/__tests__/mastra-skills.integration.spec.ts
  (real Agent: metadata injection, activation, gate-free read execution while
  an ask tool is present, plan-mode availability, no-skills no-advertisement).

- **Discovery** (`packages/agent/src/skills/skill-scan.ts`): four tiers,
  highest priority first, first-NAME-wins: (1) `<root>/.brainstrike/skills/`
  per mounted root, (2) `~/.brainstrike/skills/`, (3) `<root>/.claude/skills/`
  (Claude Code compat), (4) `~/.claude/skills/`. A skill = a directory whose
  immediate `SKILL.md` carries valid YAML frontmatter; the scan is FLAT (spec
  layout) and BOUNDED (`MAX_SKILL_FILE_CHARS` 64K / 4× byte pre-guard,
  `MAX_SKILLS` 200, `MAX_SKILL_DIR_ENTRIES` 512). Every candidate yields a
  visible entry: `ok` (with spec warnings), `invalid` (exact validation
  errors — fail closed, never a silent half-parse), or `shadowed` (names its
  winner). Frontmatter parses with the real `yaml` package
  (`skill-frontmatter.ts`; skills REQUIRE frontmatter, unlike /commands);
  validation (`skill-validation.ts`) MIRRORS @mastra/core's unexported
  `validateSkillMetadata` byte-for-byte (name 1–64 `[a-z0-9-]`, no edge/double
  hyphens, name === dirName, description 1–1024; >500-line/>5k-token
  instructions are WARNINGS). Fs is dependency-injected (commands-loader
  shape) so tier/collision logic tests run diskless.

- **Engine** (`packages/agent/src/skills/scanned-workspace-skills.ts`):
  `createScannedWorkspaceSkills` implements Mastra's `WorkspaceSkills` over
  the scan — ONE parser feeds the Settings panel, the SkillsProcessor, the
  tools, AND explicit activations, so UI status and live behavior cannot
  diverge. Lifetime = one request (lazy initial scan; `maybeRefresh()` no-op
  after; no fs watchers — mirrors the commands loader's no-polling posture).
  Reference/script/asset reads are containment-checked (no `..`/absolute/`\\`)
  and bounded (256K chars text / 1 MB assets, oversized → logged + null);
  disabled skills are invisible EVERYWHERE (list/get/has/search/reads).
  `skill_search` is a deterministic per-line term matcher over instructions +
  references (no embedding dependency).

- **Tool output budgets:** the `skill` tool's result IS the instruction
  payload, and the spec allows ~5k tokens > the generic 3000-token guard —
  so `SKILL_ACTIVATION_RESULT_TOKEN_BUDGET` (6000) is an EXPLICIT per-tool
  override in `boundToolOutputForModel` (tool-output-limits.ts), and the tool
  SELF-BOUNDS to the same ceiling with an honest truncation note
  (skill-tools.ts). The generic Mastra `toModelOutput` projection honors the
  same override, so an activation is never cut to the normal 2000-token model
  projection. `skill_read`/`skill_search` self-bound to the native budget with
  line-range / narrower-query hints.

- **Metadata injection:** Mastra's `SkillsProcessor` composed into the
  PER-CALL `inputProcessors` in `buildToolLoopOptions` (per-call options
  REPLACE the Agent-config array, so it cannot live there), FIRST so the
  TokenLimiter counts the injected `<available_skills>` block.
  `buildDefaultInstructions` adds a skills workflow line only when the `skill`
  tool survived the gates (effective tool map). EXCLUDED for provider
  `'local'` on both sides (tools + processor), mirroring personas/plan-mode.

- **Server wiring** (`apps/desktop/src/assistant-server/request-skills.ts` +
  `skills-fs-deps.ts`): the TRUSTED engine is server-built per request over
  `createSecureSkillsFs` (per-call SecureRoot open/close; reads refused
  outside the candidate containment roots) and set on
  `runtimeData.workspaceSkills` (agent-only, never serialized — mirrors
  `hookRunner`; a client-supplied value is STRIPPED). The renderer sends only
  `skillsPreference` `{masterEnabled, disabledSkillKeys}` — strictly parsed
  (`readSkillsPreference`: malformed → warn + fail-safe default), reduce-only.
  Keys are durable (`deriveSkillPreferenceKey`: `root:<roots.id>:<name>` /
  `global:<name>` — the `.brainstrike`/`.claude` tiers of one scope SHARE a
  key on purpose; never a raw path).

- **Explicit activation (`/skill:<name>` → `:skill[name]`):** user-invocable
  skills (`user-invocable` ≠ false) are a third slash-entry kind
  (`use-skill-slash-commands.ts`, merged after user commands, collision-drop
  warn-once). Execute STAGES a visible `:skill[name]` directive into the
  composer draft (trigger stripped, draft preserved, NEVER auto-sends — the
  no-silent-expansion rule is binding). At the request boundary
  (`skills-activation-context.ts`, wired in `resolveInitialAgentStream`
  between referenced-files and workspace-instructions; skipped on
  approval/resume legs) each directive resolves through the SAME engine into
  one prepended `system` message carrying `formatSkillActivation` output —
  byte-identical to the `skill` tool's payload. Unknown/disabled skills get an
  explicit in-context note; the per-skill (24K chars, same as the tool budget)
  and per-message caps (`MAX_ACTIVATED_SKILLS_PER_MESSAGE` 8, 48K aggregate)
  truncate/omit with honest notes. With skills off, directives stay inert text.

- **UI:** Settings → Skills (`skills-settings-{section,category}.tsx`,
  registered in the DESKTOP page-content only): master toggle + per-skill
  switches grouped by source, invalid entries with exact errors, shadowed
  entries with winners, spec warnings, Refresh; a rejected scan renders a
  DISTINCT error state with Retry — never the empty state. Data via
  `window.skills.scan()` (`ipc-skills{,-handlers}.ts`, channel `skills:scan`,
  preload capability-gated) which runs the SAME scan as the engine. The
  `SkillsBridge` interface + `SKILLS_BRIDGE_REQUIRED_METHODS` pin +
  `resolveSkillsBridge()` live in
  `@brainstrike/assistant-contract/skills-bridge` — NOT app-shell — because
  both app-shell (composer "/" menu) and settings-ui consume them and
  settings-ui cannot import app-shell (package cycle). The desktop
  preload-runtime contract test pins `window.skills` to that constant (exact
  set equality).

- **Preference store** (`packages/app-state/src/stores/skills-preferences-store.ts`):
  `{masterEnabled: true, disabledSkillKeys}` (only `true` entries persist),
  registered in `factory-reset-helpers.ts` (FACTORY RESET CONTRACT).

- **Trust posture (conscious ruling, mirrors workspace-instructions):**
  default-ON with NO per-skill trust gate. Skill content is instructions-only
  (prompt-level influence); the permission engine's `edit/execute:ask`
  defaults remain the backstop that keeps injected text from silently driving
  mutations, and all reads are SecureRoot-contained + bounded. The master
  toggle and per-skill disables are the off-switches.

- **Deferred:** web (no fs bridge; inline `createSkill()` skills would be the
  route); fs-watch refresh; `SkillSearchProcessor`; a create-skill scaffold
  action; rendering skill activations as composer chips.

Paired tests: packages/assistant-contract/src/__tests__/{skills,skills-bridge}.test.ts;
packages/agent/src/__tests__/{skill-scan,scanned-workspace-skills,skill-tools}.spec.ts
+ mastra-skills.integration.spec.ts + tool-output-limits.spec.ts;
apps/desktop/src/__tests__/assistant-server/{request-skills,skills-activation-context}.test.ts
+ ipc-domains/ipc-skills-handlers.test.ts;
packages/app-state/src/stores/__tests__/skills-preferences-store.test.ts +
packages/settings-ui/src/__tests__/skills-settings-section.test.tsx;
packages/app-shell/src/__tests__/use-skill-slash-commands.test.tsx +
assistant-ui-panel-wrapper-runtime.test.ts (skillsPreference opt-in field).

When changing this flow, update this section and the paired tests.

---

## EDIT CHECKPOINT LEDGER + SNAPSHOT UNDO (UNDO OF AGENT FILE EDITS)

Every agent file mutation records an ATTRIBUTION row so a per-tool-card
**Revert** control (and a per-turn **Revert all edits** footer) can restore the
prior state — from the turn's shadow-git snapshot, not from stored content
(BST-1164 T4 engine swap). Desktop-only (web local chat has no assistant
server / thread_runs rows). Capability-gated, not `isElectron()`.

- **Capture point:** INSIDE the existing per-file `withFileLock` in all four
  `run*WorkspaceFile` functions (`assistant-tools.ts`), so the before-read →
  mutate → journal write is atomic against concurrent same-file edits.
  `toolCallId` comes from Mastra's 2nd `execute` arg; identity
  (runId/threadId/resourceId) from `runtimeData.memory` for the root. Native
  delegated calls use their execution thread and the authorized durable invocation
  to resolve the child resource and current host-leg run; the tool factory's
  parent closure never owns a child checkpoint. Read timestamps and paged-read
  cursors use that same execution-thread scope. Capture is GATED on
  an active memory context and is NON-FATAL (debug on DB-absent, error on
  DB-throw) — the tool result contract is never changed.
- **Storage = IDENTITY ONLY (the T4 demotion):** op, paths, before/after
  sha256 + size, timestamps, `reverted_at`. `before_content` is NEVER
  populated (the schema column remains — no destructive migration in v1 —
  pinned by `edit-checkpoint-journal.integration.test.ts`). The content-era
  2 MB capture cap and `skipped_binary`/`skipped_too_large` states died with
  content capture (`captureBeforeState` stream-hashes any present file);
  those enum values (and `expired`) remain readable for legacy rows only.
  New rows are always `ok`/`created`/`rename`.
- **Table** `brainstrike_assistant_edit_checkpoints` (migration 051, registered in
  BOTH runners + bootstrapped byte-identically in app-shell's
  `assistant-memory-repository.ts`). NO FK (mirrors run_usage 046). Purged on
  factory reset (`db-ipc.ts` `OptionalRelationTable`).
- **Retention** (`edit-checkpoint-journal.ts`, strict-parsed env, no silent
  fallback): `BRAINSTRIKE_CHECKPOINT_MAX_ROWS` (500) hard-deletes the oldest
  rows after every insert — the whole policy; the content byte budget died
  with content capture. (Snapshot-side retention — the 50-turn ring — lives
  in `snapshot-startup-gc.ts`; see changeset-diff.md.)
- **LIST = renderer-direct DB (Path A):** `listThreadCheckpoints(threadId)` on
  the PGlite repository, across ALL runs (revertible after reload).
- **AVAILABILITY = IPC to main:** `window.assistantCheckpoints.availability(threadId)`
  → `assistant-checkpoint:availability` → `listCheckpointUndoAvailability`
  (`checkpoint-snapshot-undo.ts`): per-entry `{restorable} | {restorable:false,
  reason}` resolved from the snapshot ledger's turn brackets. Pre-engine
  entries ("predates workspace snapshots"), failed-capture turns, and
  uncovered roots render VISIBLY DISABLED with the reason — never a
  click-time surprise, never silent removal. The renderer treats an id
  MISSING from the map as unavailable (fail-safe, `availabilityForEntry`).
- **REVERT = IPC to main (Path B):** `window.assistantCheckpoints.revertEntry/revertRun`
  → `assistant-checkpoint:revert-*` → `undoCheckpointEntry`/`undoCheckpointRun`
  (`checkpoint-snapshot-undo.ts`). TURN-START SEMANTICS (deliberate change,
  ruled 2026-08-05): each journaled path is restored to its state at the
  turn's `turn-start` snapshot via `SnapshotService.restorePathsFromSnapshot`
  — a multi-edit turn's per-file undo lands on turn start, not
  just-before-that-edit, and the UI copy says so ("restore to turn start").
  A `created` path is deleted (empty-ancestor pruning bounded at the root);
  a rename is undone as restore-source + delete-destination. Resolves the
  stored `root_id` via the roots table and REFUSES a disconnected root;
  conflict gate = current disk sha256 vs the newest record's after-state
  (`force` overrides); reuses the write tools' non-fatal reindex seams
  (`checkpoint-reindex-deps.ts`, shared with rewind); stamps `reverted_at`
  (idempotent). Reverts are NOT re-journaled. `revertRun(runId)` restores
  every touched path exactly once (newest record per path wins the gate;
  older records of a handled path stamp without re-touching disk) and is
  HONEST about partial success.
- **UI = per-entry button + per-turn footer.** The per-tool-card
  `CheckpointRevertButton` (`tool-fallback-row.tsx`, keyed by `toolCallId`) undoes one
  edit; unavailable entries render "Can't restore" with the reason tooltip.
  The per-turn `CheckpointTurnRevert` footer (`checkpoint-turn-revert.tsx`)
  mounts on every `AssistantMessage`: it reads the turn's tool-call parts from
  assistant-ui message state and resolves the true revert scope via
  `selectTurnRevertScope(ids, entries, availabilityById)` against ALL of the
  thread's journal entries. Because the default `edit:ask` policy splits ONE
  run across several live assistant messages while `revertRun(runId)` reverts
  the WHOLE run, the footer is **run-scoped**: it renders once per run — on
  the run's LAST leg — and its count is the run's full snapshot-restorable
  total. A turn whose entries are ALL snapshot-unavailable renders a visible
  disabled row with the reason (`unavailableReason`), never nothing. It
  reverts each owned run **sequentially, newest first**, through the SAME
  `revertRun` bridge. Both controls mirror one UX contract — confirm →
  restore, on-disk conflict → "Revert anyway" (force), idempotent after
  success. The turn footer additionally surfaces a **visible failure state**
  with retry — never left stuck in `reverting`, never a silent return to
  idle. Pure capability gating: `null` on web, never a disabled stub there.
- **Revert-derived outcome labels (Task Ledger).** A successful `revertEntry`/
  `revertRun` additionally derives the run's outcome label from the POST-revert
  journal in `use-edit-checkpoints.ts` (`labelRunOutcomeFromJournal`): every
  revertible entry reverted → `verdict:'failed'`, partial → `'mixed'`, recorded
  via `repository.recordRunOutcome` with `source:'edit_revert'` into
  `brainstrike_assistant_run_outcomes` (migration 062). Labeling is SECONDARY:
  a failure is logged and never rejects the completed revert, and a later
  explicit user verdict upserts over the derived label by design.
- **Live-turn availability + reconciliation.** The footer must appear for the
  turn that JUST ran. The journal rows are written in main DURING tool
  execution — after the thread-open read — so `useEditCheckpoints` exposes a
  `refetch` the wrapper composes into the run-lifecycle
  `onRunFinished`/`onRunFailed` seam (no polling); every entries load also
  fetches the availability map (an availability fetch failure clears the map,
  which renders every control disabled-with-reason — fail-safe, matching what
  a click would do); a monotonic generation guard drops a stale refetch. A
  `revertRun` that unexpectedly rejects refetches BEFORE rethrowing so the
  controls reconcile.
- **Key files:** `edit-checkpoint-{journal,capture}.ts`,
  `checkpoint-snapshot-undo.ts`, `checkpoint-reindex-deps.ts` +
  `ipc-domains/assistant-checkpoint-*.ts` (desktop),
  `edit-checkpoint-context.tsx` (context + `selectTurnRevertScope` /
  `useCheckpointTurnRevert` / `availabilityForEntry`) + `tool-fallback-row.tsx` +
  `checkpoint-turn-revert.tsx` (ui), `use-edit-checkpoints.ts` (app-shell) +
  `assistant-ui-panel-wrapper.tsx`,
  `packages/assistant-contract/src/edit-checkpoints.ts`. (The journal-content
  engine — `edit-checkpoint-revert.ts`, `edit-checkpoint-errors.ts`,
  `changeset-journal-view.ts` — was DELETED in T4.)

When changing this flow, update this section and the paired tests.

---

## MODEL-FACING WORKSPACE TOOL GUIDANCE

Hosted default instructions are intentionally a compact routing layer, not a
second copy of every tool description and input schema. Per-tool mechanics live
in the canonical description and Zod schema registries documented in
`docs/agents/assistant-providers.md`; the instructions state the cross-tool
workflow and invariants below once. The authored full-registry fixture remains
guarded at 7,900 `o200k_base` tokens. The live actual Mastra/OpenRouter core and
resolved instructions are guarded at 5,000 tokens, materially below the retired
11,500-token eager boundary. Live hosted requests add `search_tools` and `load_tool`; deferred
tool mechanics arrive with the dynamically loaded definition. The fixture uses
the real hosted registry, a default-enabled representative workspace skill,
resolved conditional guidance, and first-turn `SkillsProcessor` metadata; see
`docs/agents/assistant-providers.md` for the exact measurement boundary.

Prompt compaction MUST preserve these semantics:
- **Main vs Focused:** `listWorkspaceContext.workspaceRootPath` is the MAIN
  operating root. Selected context and the default target for selection
  write-back belong to the FOCUSED root. Neither identity may be relabelled or
  silently substituted for the other.
- **Multi-root qualification:** a workspace-relative path is ambiguous when
  several roots are open, so path-bearing read/search/edit/shell calls must
  name the owning root. A rootless search means an intentional all-roots
  search only where its schema promises that behavior; it never means “guess
  Main.” Results carry root identity for follow-up calls. Root-resolution
  errors include only complete, copyable root ids inside an 800-character
  descriptor budget; overflow guidance points to `listWorkspaceContext` and
  never emits a leading delimiter when no root description fits.
- **Tapestry precision:** ranges are 1-based and inclusive. When the user names
  a symbol, section, or line range, select its exact verified span and report
  the exact range applied. Never silently fall back to whole-file selection;
  use a whole file only when the user requests it or the whole file is
  genuinely required.
- **Progressive reads:** use the cheapest discovery verb first, then read only
  the needed ranges. Continue bounded/truncated results with their advertised
  offset or range, and issue independent reads in parallel where safe.
- **Create vs edit:** `writeWorkspaceFile` remains initially visible so a
  direct create-new-file request never depends on the model discovering a
  deferred primitive. It stays edit-risk and approval-gated. A replace attempt
  against a missing file returns a trusted input error directing the model to
  the write tool; replacement is never silently reinterpreted as creation.
- **Command safety:** `executeCommand` is unsandboxed. Prefer read-only
  commands, and run destructive commands only when the user explicitly asks
  for that exact action.
- **Web privacy:** web search/extraction is for public external information and
  sends queries or URLs to an external service. Never include secrets or
  private workspace content, and never use web retrieval as a substitute for
  local workspace tools.

The model-facing workspace projections share only mechanical invariants through
`workspace-model-projection-helpers.ts`: record and integer guards, Unicode-safe
end/middle clipping, text-envelope construction, and serialized-envelope budget
measurement. Domain result types, parsing/coherence rules, pagination, ranking,
producer constants, and omission guidance remain local to each projection.
Path policy also remains explicit at each call site: context and retrieval
escape CR, LF, U+2028, and U+2029 while preserving repeated whitespace needed
by follow-up file tools (800- and 700-character path ceilings respectively);
inspection previews collapse whitespace onto one line at an 800-character
ceiling. Search projections (BST-1185) emit the producer path VERBATIM with
line breaks escaped and never clip it — a clipped path is an unusable
selector, so an oversized path overflows the projection budget and its item
is omitted with an advancing offset instead. Malformed or over-budget output
continues to fail visibly; the shared helpers must never add coercion or
fallback.

Conditional assembly still advertises only tools that survived runtime gates.
Remove duplicated prose to recover prompt budget; do not remove or weaken the
invariants above.

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
  `apps/desktop/src/__tests__/assistant-server/assistant-tools-write.integration.test.ts`
  (real-fs refuse/recover behavior, `utimes`-forced external edits).

When changing this flow, update this section and the paired tests.

---

## WORKSPACE ROOT IDENTITY: MAIN vs FOCUSED

Two DISTINCT root concepts exist in a multi-root workspace — never conflate
them (the pre-split code did, with a false "first root is the primary/focused
one" comment):

- **MAIN root** = the assistant's OPERATING root. Defined as
  `activeRootIds[0]` in the file-explorer store (insertion-ordered, persisted
  in file-explorer-storage v5 — persisting the order persists the choice; no
  extra field, no DB migration). Drives the hooks `primaryCwd` (the stdin
  `cwd` of UserPromptSubmit/Stop/Session events and the spawn cwd of GLOBAL
  hooks) and the model-facing "main root path"
  (`listWorkspaceContext.workspaceRootPath`). Stable: only "Set as main" (a
  pure store reorder via `setMainRoot`) or disconnecting the main root
  (which promotes `activeRootIds[1]`) changes it. Re-adding a removed root
  appends to the END — a re-added ex-main root is demoted (visible +
  recoverable, by design).
  - **Restore-order preservation (`setActiveRoots`, `active-root-actions.ts`):**
    the desktop boot restore (`runMultiRootRestore` in
    `packages/file-explorer-hooks/src/use-file-system.ts`) rebuilds
    `activeRootIds`/`rootDescriptors` from a SEPARATE main-process-persisted
    `rootsList`, owned only by
    `apps/desktop/src/ipc-domains/workspace-root-registry.ts`, which is plain
    add-order and has NO notion of Main. IPC and the renderer are projections:
    add/restore/disconnect complete in that registry before renderer state
    changes. A rejected disconnect leaves renderer state intact. Unavailable or
    transiently unmountable entries remain persisted with
    `permissionState:'unknown'`; they are retried later and excluded from the
    mounted capability set and DB live-root convergence. The legacy
    `lastFolderPath` is presentation-only and may reference only an
    already-persisted mounted root; it never inserts or removes roots.
    `setActiveRoots` is therefore
    ORDER-PRESERVING, not a blind overwrite: ids still reported keep their
    existing relative order from the already-rehydrated store (the Main slot
    survives), a newly-reported id not previously known appends at the END,
    and an id no longer reported as granted drops out. This
    is what makes the storage-v5 "persisting the order persists the choice"
    claim above actually hold across a restart — without it, `runMultiRootRestore`
    calling `setActiveRoots(storedDescriptors)` after hydration would silently
    re-derive `activeRootIds[0]` from the rootsList's add-order and demote the
    user's declared Main root on every restart.
- **FOCUSED root** = SELECTION state (`currentFolderId`). Drives the Terminal
  panel's DEFAULT cwd, selection scoping, and the selection write-back default
  (`resolveWriteBackTarget` untouched). It flips on any incidental click
  (`handleTreeInteraction` in `file-explorer-sidebar.tsx`), so it must NEVER
  drive hooks/model cwd. Surfaced visually, never described as the
  assistant's root.

**The Terminal's cwd is FOCUSED-by-default, PINNED-when-asked, and the pin is
SHELL-ONLY (BST-1457).** `TerminalPanel` follows the focused root until a
surface publishes a `terminal-target-store` pin — "Open in Terminal" on a
Worktree Map card, the Mode chip's worktree menu, or a Folder chip root row. A
pin carries `{ cwd, rootId }` because the two differ for a nested checkout,
survives focus changes on purpose, and is released by the panel's own "Follow
focused folder" control or by factory reset. This is the ONE place a
FOCUSED-root default is deliberately overridable: unlike hooks/model cwd
(which must never follow focus), a terminal is something the user aims
explicitly. The pin scopes ONLY the shell (`HumanTerminal`) — the panel's
Command sessions surface (`CommandSessionInventory`) always takes the FOCUSED
root, never the pin, so its destructive `stop`/`remove`/`write` actions can
never silently retarget onto a checkout pinned in a different root. An
explicit "Open in Terminal" also forces the panel back to the shell surface
even if Command sessions was last selected — the requested PTY must never
start invisibly behind another tab.

**Forge identity (BST-1391) follows MAIN, never FOCUSED.** The workspace
bar's `PrChip` and the BranchChip's forge diagnostic both resolve their
`gh`-backed pull-request status from the MAIN root's repository (the bar's
`primaryRoot`, `activeRootIds[0]`) — the same root that drives hooks/model
cwd. A FOCUSED selection must never drive which repository's remote gets
parsed or which branch's PR gets fetched, for the identical reason it must
never drive cwd: it flips on incidental clicks, and a forge lookup silently
following it would attribute a PR to the wrong repository the instant the
user clicks around the tree.

**Request fields** (`packages/assistant-contract/src/runtime-data.ts`): the
wrapper attaches `mainRootId` (= adapter `activeRootIds[0]`) and `mainRootPath`
(the descriptor's absolute path) per request. They are an ORDERING HINT for the
server — a preference, not a security boundary. The server may use the path to
match that ordering hint after reconnects; neither field is the durable
thread-binding authority. `workspaceRootPath` stays the FOCUSED root (selection
scope) — unchanged.

**Thread/run binding:** Desktop data-stream threads persist their first
request's explicit Main root in `mastra_threads.metadata` as
`operatingRootId` plus display-only name/path fields. The durable id, not the
path or label, is the execution authority. At first request preparation,
app-shell resolves the mounted adapter root path to exactly one live DB
`roots.id`; it fails visibly rather than persisting an adapter id or guessing.
Later global Main/Focused changes do not retarget that thread or its composer
chip. Request preparation reuses the persisted id and emits
`boundWorkspaceRootId`; approval/resume preparation is pinned by an in-memory
copy before the metadata-store rerender can land.
Restored tab ids can become selected before their `mastra_threads` rows have
loaded. That state keeps the composer disabled and causes root resolution or
persistence to fail visibly; it must never be treated as missing metadata and
rebound to the current Main root.
Desktop validates that id against its server-loaded live DB roots before hooks
or the initial manifest can use another mounted root, then orders the bound root
first. An omitted native workspace-tool `root` resolves to the binding. An
explicit selector for another currently mounted root remains an observable
cross-root operation. An explicitly
blank selector is invalid and never broadens an optional search to all roots or
falls through to the thread binding. Bound-root resolution requires an
authoritative `workspaceRoots` inventory; if DB enrichment is unavailable, the
tool fails visibly instead of comparing the durable id with a synthesized
path-backed root or silently clearing the binding. A missing, stale, or
disconnected bound id fails visibly as `bound_workspace_root_unavailable` with
HTTP 409; it never path-falls back or silently adopts the new global Main root.
The one intentional omission exception is
`readWorkspaceContext` with no explicit `filePaths`: renderer-selected paths and
Tapestry ranges are relative to the FOCUSED `workspaceRootPath`, so that
selection-default read resolves the focused path against the authoritative
inventory instead of the thread binding. If the inventory is unavailable, the
selection-default read fails visibly; focused renderer state never authorizes a
path-backed root. Supplying `filePaths` restores the normal omitted-root binding
rule. Disconnect transitions also revoke
already-enriched in-flight runtime snapshots, while a later authoritative live
root load clears that revocation after reconciliation/reconnect.

**Initial workspace-root manifest** (`packages/agent/src/workspace-root-manifest.ts`):
every fresh hosted-provider turn receives one `system` message before the
model's first action. Existing leading system context stays ahead of it, so
Desktop workspace instructions retain their documented frontmost precedence.
The bounded JSON data block contains only the
server-resolved root selector, display name, canonical path, and Main/Focused
roles — never a tree, file list, selection list, or glob result. It is capped at
3,000 serialized characters and five roots; Main and Focused are prioritized,
and any remainder is reported with explicit `shown`/`omitted` counts. Exact
root selectors are never truncated: an unexpectedly oversized selector is
omitted and counted rather than becoming an unusable or misleading id. Root
names/paths are clipped, JSON-escaped, and explicitly described as inert data.
`listWorkspaceContext` remains the detailed, refreshable source for complete
root inventory, selections, indexing, ranges, and budgets.

The injection lives at the shared `toAiSdkStyleStream` boundary, after Desktop
has enriched the runtime but before Mastra memory selects the current turn, so
it covers OpenAI, Anthropic, OpenRouter, and Hosted Web consistently. Desktop
with a successful empty DB query emits `state: available, count: 0`; Hosted Web
or degraded/legacy Desktop state emits `state: unavailable` and never invents
a client/path-derived selector. The compact built-in local model is excluded to
preserve its 8,192-token context budget.

**Server reorder** (`apps/desktop/src/assistant-server/workspace-roots.ts`):
`enrichRuntimeDataWithWorkspaceRoots` loads live DB roots (`created_at ASC`)
then prioritizes an exact `boundWorkspaceRootId` when present; otherwise it
calls the pure `orderWorkspaceRoots(roots, mainRootId, mainRootPath)` — match by
rootId first, else by resolved absolute path (covers legacy client ids that
diverged from DB ids; web enrichment never runs, FSA roots have null paths).
An unmatched binding stays unmatched so tool execution can fail visibly;
unmatched/absent Main keeps `created_at` order (the legacy tiebreak) with a
debug log. `roots[0]` is therefore GENUINELY the thread-bound/Main root — no
`buildHookManager` change was needed. On a DB load/query failure, RuntimeData
remains unenriched and workspace-tool authorization fails closed; the renderer's
FOCUSED `workspaceRootPath` is selection state only and never becomes a
synthesized root. A successful zero-root query records an explicit
`workspaceRoots: []`. This is distinct from an unresolved/query-failed root
inventory and lets `listWorkspaceContext` report the valid empty-workspace state
without disguising a bridge failure. Enrichment also clears any stale FOCUSED
`workspaceRootPath` in that zero-root state; otherwise the trusted empty
inventory and renderer focus would be inconsistent and stream initialization
would fail before the empty-workspace result could be reported.
The desktop HTTP boundary strips any client-supplied `workspaceRoots` before
enrichment. Only the DB result may populate the trusted manifest/tool inventory;
renderer fields can order or focus roots but can never substitute adapter ids
for the durable selectors accepted by native tools.

**Background indexing readiness (BST-630).** The shared filesystem provider's
`isAccessLoading` and the roots registry's `rootsReconciliationSettled` own
restoration readiness. Database and runtime dependencies must also exist.
Until they settle, sync stays `waiting`; elapsed time never bypasses them.
`resolveDbRootId` still awaits each root's registration before import. The
indexer scans through the filesystem adapter rather than the rendered tree,
so tree loading and expanded-path restoration neither delay indexing nor
cancel an active pass. There is no tree-restoration grace timer. Root-access
restoration resuming, root-set changes, pause, and unmount all stop the
renderer-side sync loop, but they differ on the host-owned
`source: 'background-indexing'` backfill, and that difference is the contract
(BST-1654). Unmount — including the teardown effect re-running on plain
`service` identity churn — calls `WorkspaceCollectionSyncService.detach()`:
abort the renderer loop, drop the progress subscription, leave the durable run
alone, re-attach on the next `sync()` via `selectRecoverableBackgroundBackfill`.
A deliberate stop calls `cancel()`, which also kills the host run.

Detaching drops tracking, never cancellation authority. An explicit pause or
disable cancels in-flight `background-indexing` runs regardless of which
provider instance is mounted, so `cancel()` and the disabled `sync()` path both
enumerate `getBackfillsInFlight()` and cancel every run carrying the
`background-indexing-backfill:` request-id prefix: the detached run sits in no
instance's `activeBackfill`, and the instance that observes the stop is
typically a fresh one tracking nothing at all. Runs the prefix does not claim
are left alone, and a stop that cannot be delivered rejects rather than
reporting success. Both halves are load-bearing — satisfy one by trading the
other back and the user either loses indexing on navigation or cannot stop it.

Provider regressions cover delayed access/registry/DB readiness beyond the old
grace window, tree-only churn, and in-flight cancellation in
`packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-provider.test.tsx`
— the lifecycle pair there is "leaves an in-flight background-indexing backfill
running when the provider unmounts" plus the "an explicit stop after the
provider detached from a backfill" pause/disable cases. Service-level coverage
is the `detach()` and "cancellation authority over a detached run" describes in
`packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-service.test.ts`.
Successful root imports refresh the active collection's statistics once after
all chunking/assignment batches finish. The earlier managed-cache refresh sees
files before chunks exist; waiting for embedding completion would leave the
popover claiming current zero chunks after faster startup. The real-PGlite
large-import regression verifies 108,000 pending chunks before any embedding
worker runs. This uses the existing rollup API and background scheduler priority.

**Surfaced UI** (the composer WORKSPACE BAR below is always visible; every
OTHER surface here is forest-mode/multi-root only, so a single root shows no
additional explorer/status chrome):
- Root section headers (`root-section-header.tsx` + sidebar wiring): "Main"
  badge on the main root (exactly one; the badge MOVES when main changes —
  sections never reorder), persistent focused affordance (`data-focused`
  attr + left accent — app state, NOT `:focus-visible`), full path tooltip.
- Status bar (`packages/app-shell/src/status-items/workspace-root-status-item.tsx`,
  left, beside the database item): main root name (+N), popover listing every
  mounted root (path or "browser folder", Main badge, Focused marker) with a
  per-row "Set as main" → `setMainRoot`.
- **`roots.kind = 'worktree'` (BST-1390).** A root mounted for a BrainStrike-
  managed worktree carries its own kind, set at INSERT by `reconcileRoots` from
  the ledger-only `window.worktrees.listManagedPaths()` path set. This boot-
  critical read never builds git inventory or resolves workspace-root joins.
  Until the first successful desktop ledger read, reconciliation updates
  existing rows but defers new inserts so a transient bridge failure cannot
  durably misclassify a managed worktree as `path`.
  `kind` is never modified on an existing row, so a worktree root registered
  before W3 keeps its old kind — visible, not silently rewritten. The DB
  column has a real CHECK constraint (migration 039, widened by migration 111
  to add `'worktree'`) — this is NOT type-level-only, unlike an earlier draft
  of this plan assumed. Background indexing defaults to OFF for this kind
  [D8] (see `defaultBackgroundIndexingEnabled` in
  `packages/app-state/src/stores/background-indexing-preferences-store.ts`,
  consumed by the one sync-target filter in
  `workspace-collection-sync-provider.tsx`) until the hash-reuse cost is
  measured against the BST-393 benchmark. The Explorer root surfaces (forest
  root headers and the single-root status row) and the workspace-root status
  popover surface this as `Not indexed`, explain that
  managed worktrees are excluded by default to avoid duplicate corpus
  indexing, and offer a per-root opt-in. The durable DB root id keys that
  persisted preference; the adapter root id keys only the transient mounted-
  root status consumed by those UI surfaces. Opting one root in never changes
  another worktree or suppresses eligible non-worktree roots. If every mounted
  root is excluded, the sync status remains visibly `waiting` with the same
  explanation rather than silently publishing no work. A mounted root with a
  durable id but no published kind is deferred from the current sync pass;
  publishing its reactive kind map restarts the pass, so mid-session Add Folder
  cannot race the D8 exclusion.
- **The second (and last) sanctioned picker-less mount.** `fs:addRootByPath`
  now accepts a path authorized by EITHER the recent-roots ledger (BST-1395)
  OR the managed-worktree authorizer (BST-1390, widened in the BST-1392
  follow-up): a live `brainstrike_worktrees` row whose realpath is REACHABLE by
  the same rule adoption's `assertReachable` applies — under the realpath'd
  managed directory, or inside a granted workspace root per a FORCED-FRESH
  inventory's containment (a `roots` write never dirties the cached snapshot,
  so a default cached read could honor a just-closed root; the shared
  `isReachableCheckout` predicate in `worktree-adopt.ts` backs BOTH
  `assertReachable` and `isAuthorizedWorktreeMountPath`, so the two rules
  cannot drift). An unavailable inventory refuses only the in-root arm, at
  WARN — the managed-directory arm is inventory-free. An outside-roots row —
  e.g. its granting root was disconnected after
  adoption — stays refused; a ledger row alone is never a mount grant. The
  ledger is checked first so a broken authorizer cannot take the recents path
  down with it. Managed worktrees are deliberately NOT written into `recentRootsList` at
  grant time — that list is the user's folders, not the app's scratch
  directories — and (BST-1390 Task 10) `restoreRoots` now also skips recording
  a `kind='worktree'` entry into recents on relaunch, closing the leak the
  grant-time suppression alone left open across a restart. **BST-1393 (W6)
  added four new CALLERS of this path (File ▸ Open Recent, argv/`second-instance`,
  macOS `open-file`, and the composer folder drop) and NO new authorization:
  each is a request that these same two gates still decide, and a refusal is
  surfaced with the picker as its remedy.**
- **Low-friction folder connection — the OS-gesture delivery machinery
  (BST-1393, spec §7 [D10]).** Five gestures ask this app to connect a folder:
  File ▸ Open Folder… (⌘O), File ▸ Open Recent, `brainstrike <path>` /
  `second-instance` argv, macOS `open-file` (also what a click in the Dock's
  recent-documents list delivers, since every grant-recording mount calls
  `app.addRecentDocument`), and a Finder folder dropped on the composer's
  workspace bar. All five converge on ONE renderer seam — `useConnectFolder`
  (`packages/app-shell/src/workspace-connect/use-connect-folder.tsx`, see the
  workspace-bar section below for the seam + drop details) — and that seam
  calls the existing picker-less `fs:addRootByPath`. W6 added no third
  authorization door.
  - **Main→renderer travels over the `window.workspace` bridge**
    (`workspace:open-folder-picker`, `workspace:open-path`, plus the
    renderer→main `workspace:open-path-ready` ping and the preload-local
    `getDroppedPath` = `webUtils.getPathForFile`). A bridge of its own rather
    than a fourth `window.platform` member (ruling B1): the platform bridge's
    exact-set pin is duck-typed by object literals in
    `context-action-registry.test.ts`, which a new required member would
    silently invalidate. `packages/app-shell/src/workspace-connect/workspace-connect-bridge.ts`
    is canonical for the required-method set, the five-member
    `WorkspaceOpenOrigin` union (`argv` · `drop` · `menu-recent` ·
    `open-file` · `second-instance`, each side compile-time pinned), and the
    TWO exact refusal strings the renderer's remedy matcher shares with
    main's `resolveGrantedRootHandle` — the renderer strips the
    `ipcRenderer.invoke` error envelope (`IPC_INVOKE_ENVELOPE` in
    `use-connect-folder.tsx`, kept byte-identical with
    `hooks/use-workspace-bar.ts`'s copy) before matching, so the remedy fires
    against the enveloped production rejection, not just the bare unit-test
    string. The stripper matches ANY `*Error:` name after the envelope, not
    only the literal `Error:` — main throws the refusal as an `AccessError`
    and the class NAME survives IPC serialization
    (`Error invoking remote method 'fs:addRootByPath': AccessError: …`); a
    literal-only stripper left `AccessError: ` on the message and silently
    degraded the remedy to the generic toast (caught by the BST-1393 L5 e2e
    against the real built app, invisible to every unit fixture that spelled
    the envelope with a plain `Error:`).
  - **File ▸ Open Folder… (⌘O) does not open a dialog in main.** The menu
    item (`apps/desktop/src/application-file-menu.ts`, pure and unit-tested)
    pushes `workspace:open-folder-picker` to the FOCUSED window and the
    renderer runs the SAME `addRootDirectory()` the Folder chip's Add
    folder… runs, so grant recording, recents refresh and the reconciliation
    nudge stay on one path. The menu callbacks forward Electron's
    click-handler window (the `(_menuItem, browserWindow)` idiom the View
    items use) and `getFocusedWindow()` is only the fallback —
    `getFocusedWindow()` alone is null whenever the app is not the OS-active
    application, which made a programmatic `getMenuItemById(...).click(...)`
    (the e2e's only way to drive the menu) a silent no-op. A ⌘K "Open folder…" command rides the same
    renderer flow (`createGlobalCommands`'s targetless-command idiom).
  - **File ▸ Open Recent projects main's own `recentRootsList` ledger**,
    capped at 10 rows (`FILE_MENU_RECENT_LIMIT` — the ledger's 50 is storage
    hygiene, not a menu bound), newest-first, labelled by basename with the
    full path as tooltip, and DISABLED (not hidden) when empty. It rebuilds
    on a coalesced 250 ms schedule whenever the root-grant subscriber fires
    (the same subscriber that calls `app.addRecentDocument`). **There is NO
    "Clear Menu" row** — a deliberate deviation from the original W6 plan:
    clearing only `app.clearRecentDocuments()` left every visible row
    unchanged (a button that visibly does nothing), and clearing the ledger
    from a menu item would silently revoke picker-less grants. Emptying the
    ledger is "Remove from recents" ([D9]), still deferred.
  - **A recent-menu click sends `workspace:open-path` with
    `origin: 'menu-recent'` directly to the focused window; the
    launch-scoped producers go through `createWorkspaceOpenQueue`**
    (`apps/desktop/src/workspace-open-queue.ts`): `open-file` is registered
    at MODULE scope (macOS fires it before `whenReady`, and it stays
    registered in E2E mode because `app.emit('open-file', …)` is the only
    way that entry point is e2e-observable), launch argv is enqueued ONCE
    inside `whenReady` (never re-enqueued by `activate` recreations), and
    `second-instance` is registered only when NOT in E2E mode (ruling L3 —
    e2e cannot launch a competing process; its parse is `folder-argv.test.ts`'s
    and its delivery is the same queue the `open-file` e2e proves).
    **The unpackaged app-path skip in `resolveFolderCandidatesFromArgv` is
    by IDENTITY (`app.getAppPath()`), never by argv position** (BST-1393 L5,
    observed live 2026-08-27): Chromium regroups the argv it delivers to the
    first instance's `second-instance` handler as
    `[program, ...switches, ...positionals]` — injecting its own switches —
    so the `electron .` app-path positional lands at an arbitrary index; a
    fixed `slice(2)` mis-parsed it into a folder-open candidate for the repo
    checkout (and would silently mount it if the repo is in the recents
    ledger). Only the FIRST positional matching `appPath` OR `appEntryPath`
    (the running bundle's `__filename` — recognizes the FILE-entry spelling
    `electron <path>/dist/main.js`, where `app.getAppPath()` is dist/
    itself, BST-1459) is skipped: positional relative order survives the
    regrouping, so that is the implicit app argument; a later duplicate is
    an explicit `electron . .` request and stays a candidate. An empty
    `appPath`/`appEntryPath` THROWS (`path.resolve('')` would silently alias
    the cwd). Packaged parsing never consults either.
    Candidates pass `filterDirectoryOpenCandidates` first: non-directories
    and unstat-able paths are loudly skipped BEFORE the IPC channel, capped
    at `MAX_PENDING_OPEN_REQUESTS` (16, oldest dropped with a warn) before
    the sync stat loop so a runaway `second-instance` cannot stall main.
  - **Queue delivery is gated on a TWO-condition handshake, per window**
    (BST-1393 PR #2682 re-review — both halves exist because single-signal
    versions each shipped a Critical bug): `loadFinished` tracks
    `did-start-loading`/`did-stop-loading` (the WebContents-level SYMMETRIC
    pair — `did-finish-load` is main-frame-only, so pairing it with
    `did-start-loading` strands the queue after a subframe-only load, e.g.
    the canvas surface's artifact `<iframe>`), and `rendererReady` is the
    renderer's own explicit ack: `WorkspaceConnectHost` pings
    `workspace:open-path-ready` in the SAME effect that subscribes
    `onOpenPath`, because a loaded document is not a mounted listener and
    Electron never replays a `send` nobody heard. `rendererReady` resets
    ONLY on a real main-frame document replacement (`did-start-navigation`
    with `details.isMainFrame && !details.isSameDocument`) — resetting it on every
    `did-start-loading` would clear it on a canvas-iframe navigation with no
    second ping ever coming. The ready channel is registered ONCE at module
    scope (`apps/desktop/src/workspace-open-ready-ipc.ts`; the IPC registry
    rejects double registration) and routed per window via a
    `webContents.id`-keyed callback map that `createMainWindow` populates
    and `closed` cleans up — the id is CAPTURED at registration, never read
    inside the `closed` handler, because the `win.webContents` getter itself
    throws "Object has been destroyed" once `closed` has fired (an uncaught
    main-process exception on every window close until the L5 fix; pinned by
    `workspace-open-lifecycle.test.ts`'s destroyed-getter case). The queue
    also detaches on `closed` explicitly, because `isDestroyed()` still
    reports `false` while a window is dying.
  - **Delivery ≠ authorization**: the queue is a buffer of REQUESTS. Every
    delivered path still goes through `isWorkspaceOpenPathRequest` narrowing
    (malformed payloads dropped with a log, never coerced) and the seam's
    `fs:addRootByPath` gates. Nothing in this machinery calls
    `recordRecentRoot`.
  - Paired tests: `apps/desktop/src/__tests__/workspace-open-queue.test.ts`,
    `workspace-open-ready-ipc.test.ts`, `main/workspace-open-lifecycle.test.ts`,
    `folder-argv.test.ts`, `application-file-menu.test.ts`, and the BST-1393
    describe in `apps/desktop/e2e/add-root-ui.smoke.desktop.test.ts`
    (root-header menu + Open in Terminal `pwd` falsifier, File menu driven
    from main, `open-file` granted-mounts / never-granted-refuses end to
    end).
- Composer **workspace bar** (`packages/assistant-ui/src/workspace-bar/`,
  wired by `packages/app-shell/src/hooks/use-workspace-bar.ts` +
  `use-thread-checkout-status.ts`, mounted in the composer stack as a SIBLING
  of ThreadContextMeter — never nest it there; the meter is being reworked).
  It replaced `operating-root-chip.tsx` (retired in BST-1396) and is ALWAYS
  visible, single root included: BST-1396 removed the >=2-roots gate because
  the bar's job is ORIENTATION, not disambiguation. Zero roots render the
  "Choose a folder" CTA rather than nothing.
  - Folder chip: this thread's PRIMARY (= persisted `operatingRootId`, else
    the current MAIN root) plus `metadata.secondaryRootIds` as a `+N` badge
    and per-root rows. The primary's `rootId` is ALWAYS a durable `roots.id`
    — with no persisted binding, the MAIN root's row is resolved BY PATH
    (never an adapter id), and an unresolvable path leaves the chip's primary
    undefined rather than inventing one.
  - **"Make primary" re-binds the THREAD** through the same three
    `operatingRoot*` metadata keys `persistThreadRootBinding` writes, in ONE
    metadata write together with the secondary set. It NEVER calls
    `setMainRoot` — the global MAIN root is a workspace-wide ordering choice
    and stays untouched. "Remove from thread" likewise only edits
    `secondaryRootIds`; it never disconnects the folder from the workspace.
    While checkout mode is Worktree, making a secondary primary includes the
    Local checkout transition in that SAME write, so the operating root and
    checkout record never disagree. The selected secondary becomes primary,
    every existing secondary except that selected root remains attached, and
    the former worktree primary is removed from the thread. That removal keeps
    a stale action from re-promoting a managed worktree while the checkout mode
    remains Local; re-entering it goes through the worktree picker. A success
    toast makes the implicit Local transition and worktree removal explicit. The secondary named by
    `checkoutLocalRootId` keeps its Remove action visibly disabled with “This
    folder is where Hand off returns to.”; other secondary actions are unchanged.
    A failed write retains the prior folder set and checkout record. The
    disabled return action remains keyboard-focusable and exposes its
    full-contrast reason as an accessible description.
  - "Add folder…" adds the folder GLOBALLY (the existing multi-root
    `addRootDirectory` flow) AND records it as a thread secondary. The durable
    `roots` row is written by the roots-reconciliation effect, so the id
    lookup AWAITS that effect's own "root registered" notification
    (`roots/root-registration-events.ts`, BST-1400) instead of polling the
    database — a module-scoped event bus, since `useWorkspaceBar` renders as a
    REACT SIBLING of the `RootIdentityProvider` subtree that owns
    `useRootsReconciliation` and cannot reach its callbacks through context.
    The wait is still BOUNDED (`ROOT_ROW_WAIT_TIMEOUT_MS`, ~5 s, same budget
    the old 20 x 250 ms poll had). Exhaustion is not a silent no-op: it logs
    and raises a "Folder added, but not attached to this thread" toast. The
    seam is EPOCH-based (a per-key generation counter), not a one-shot flag —
    re-adding a removed folder mints a fresh adapter id and is a genuine
    SECOND registration of the same path, so a plain "ever registered?" flag
    would resolve stale against a row that is still absent; a waiter instead
    captures the generation before its first failed read and only a strictly
    later one satisfies it.
  - Mode-chip checkout metadata is owned by `use-thread-checkout.ts`. Selecting
    a worktree first resolves its mounted path to a durable live `roots.id`, then
    uses the workspace bar's serialized folder-write queue to persist the
    `checkout*` fields, full `operatingRoot*` triple, and secondary-root demotion
    in ONE metadata write. `checkoutLocalRootId` durably records the Local
    `roots.id` at entry; secondary-list position has no semantic meaning. The
    queue tail carries that id plus resolved primary and secondary root objects,
    so an overlapping hand-off can promote the remembered Local root without
    using stale render state or writing an incomplete binding. A reconciliation
    failure rejects before enqueueing. Hand-off promotes the tracked Local root
    when it has a complete roots row; a disconnected tracked root is logged and
    refused, while legacy partial state with no tracked Local root clears checkout
    mode, warns/toasts that the folder did not follow, and keeps its current
    primary. The repository read sanitizer preserves that legacy worktree shape
    without weakening the complete-metadata requirement for new writes. Every
    checkout-mode transition atomically strips `checkoutBranch`;
    the Local transition also removes both worktree keys and
    `checkoutLocalRootId`, so no stale checkout authority survives the hand-off.
  - The Worktree Map tab (BST-1392, `packages/app-shell/src/worktree-map/`)
    is capability-gated the same way Changes/Canvas/Terminal are:
    `apps/desktop/src/renderer/components/root-layout-content.tsx` resolves
    `isWorktreesBridgeAvailable()` once via `useMemo` and conditionally spreads
    `worktreeMapPageContent` into `buildWorkspaceApps`, never an `isElectron()`
    check — web omits the tab entirely (no `window.worktrees`, no registration).
    Its `onNewThread`/`onHandOffToLocal` handlers do NOT write checkout
    metadata directly: they call
    `useWorktreeCheckoutIntentStore().publish({branch, path, threadId,
    worktreeId})`, a ONE-SHOT request the intent-consumer
    (`use-workspace-bar-mode.ts`) applies to the SELECTED thread exactly once —
    `consume(threadId)` clears the entry so a re-render cannot re-apply it —
    by calling the SAME `onSelectWorktree`/`onHandOffToLocal` callbacks the
    Mode chip's own picker and create-sheet call. `use-thread-checkout.ts`
    remains the ONLY writer of `mastra_threads.metadata.checkout*`; the intent
    store is a cross-component REQUEST queue, never a second write path. A
    failed apply surfaces through the same `logger.error` + toast path the
    chip uses and is not retried.
  - Recents come from main's `recentRootsList` ledger
    (`apps/desktop/src/ipc-domains/workspace-recent-roots.ts`, read through
    `fs:listRecentRoots`), minus folders already mounted in this workspace.
    Every supported flow that may write the ledger through the shared file-system
    instance increments its `recentRootsRevision`, including grants, startup
    multi-root restore, and restore-access registration; the workspace bar reloads
    the ledger from that canonical signal, so Explorer Add Folder and future grant
    or restore callers need no bar-specific refresh wiring. The signal is an honest
    superset: managed-worktree mounts may also increment it because the renderer's
    descriptor does not expose main's grant source, while main deliberately keeps
    managed worktrees out of Recents. Recents loads use a monotonic request generation,
    and an older overlapping response cannot replace a newer snapshot.
    `fs:addRootByPath` has TWO ordered gates: first that ledger (BST-1395), then
    the server-owned managed-worktree authorizer (BST-1390, spec §6.2; widened
    in the BST-1392 follow-up), which requires a live ledger row plus
    reachability per adoption's `assertReachable` rule (managed-directory
    containment, or in-granted-root containment per a forced-fresh inventory)
    and fails closed on every authorizer error. A recents-ledger grant is re-recorded; a managed
    worktree grant is not recorded into Recents at grant time, and `restoreRoots`
    now batch-reads persisted root kinds and skips `kind='worktree'` entries on
    relaunch (BST-1390 Task 10), so that suppression survives relaunch when the
    kind query succeeds and the row exists; it deliberately fails open to ordinary
    Recents behavior if the kind query throws or the root row was never written. Thus **the BAR** cannot
    mount an arbitrary path: a stray or stale path string is rejected. This is
    a hardening boundary against a compromised renderer by itself: the ledger
    remains one input to the main-owned mount decision, never a replacement for
    that decision. BST-1401 additionally rejects renderer mutation of
    `rootsList`, `recentRootsList`, their quarantine records, `notesVaultRoots`,
    and `lastFolderPath` through `storage:setItem`, `storage:removeItem`, and
    `storage:clear`. Desktop E2E uses a separately registered test-mode-only
    seed channel; production never registers it. Paths are keyed with a stripped
    trailing separator, so `/ws/alpha/` and `/ws/alpha` are one slot. A CORRUPT
    ledger is quarantined to `recentRootsList.corrupt`, logged at ERROR, and
    reset (mirroring `readStoredRootsOrQuarantine`) rather than left permanently
    unrecoverable; until the next grant re-populates it, `addRootByPath` rejects
    with the normal "never granted" remedy. The cap (`RECENT_ROOTS_LIMIT`, 50)
    is storage hygiene, deliberately far above realistic mount counts so
    connected roots cannot evict disconnected grants. Desktop-only — web has no
    ledger and therefore no `onAddRecent` affordance (capability gating, not an
    `isElectron()` check).
  - **Finder folder drop (BST-1393, spec §4.1 [D7]) — the bar's THIRD add
    gesture**, alongside Add folder… and Add recent…, and the only one that
    routes through the desktop `window.workspace` bridge rather than
    `@brainstrike/file-explorer-ui/shell`'s `useFileSystem()` directly.
    - **`useConnectFolder` (`workspace-connect/use-connect-folder.tsx`) is the
      ONE seam every W6 entry point converges on**: File menu, `brainstrike
      <path>` argv, macOS `open-file`, `second-instance` argv, File ▸ Open
      Recent, AND a Finder drop — five `WorkspaceOpenOrigin` values (`argv` ·
      `open-file` · `second-instance` · `menu-recent` · `drop`), all logged on
      refusal so a "why did this folder mount / not mount" question always
      names its real gesture. **Security posture (ruling S1): a path from any
      of these is a REQUEST, never a grant.** `open-file` and argv are
      attacker-influencable (any process can run `open -a BrainStrike
      <path>`), so `connectPath` calls the SAME picker-less `addRootDirectoryByPath`
      Add Recent uses (never a new grant door) and renders the SAME
      "never granted, use Add folder…" remedy toast on refusal. `connectPath`
      resolves to the mounted `DirectoryHandle` on success and `null` on
      every refusal/failure path (each already toasted here) — a caller that
      needs to react to success, rather than just fire-and-forget like
      `workspace-connect-host.tsx` does for the other four origins, can.
    - **`extractDroppedFolderPaths` (`workspace-connect/extract-dropped-folder-paths.ts`)**
      turns a drop's `DataTransferItem`s into absolute paths, synchronously:
      a `DataTransferItem` goes invalid the instant the drop event settles
      (the same contract `packages/notes-vault/src/core/drop.ts` established),
      so `webkitGetAsEntry()`/`getAsFile()` must both run inside the drop
      tick. Files vs. folders are told apart by ASKING THE DOM
      (`entry.isDirectory`), never guessed from `size`/`type` and never
      forwarded blind to `connectPath` (ruling D1) — a plain file sent there
      would come back with a GRANTS-flavored refusal that misdescribes the
      problem. Every non-outcome is counted, not swallowed, in three SEPARATE
      buckets so the notice never names the wrong noun: `skippedFileCount`
      (confirmed plain files), `unreadableCount` (items whose kind
      `webkitGetAsEntry()` threw before revealing — never confirmed to BE a
      folder), and `unresolvedCount` (confirmed folders whose `File` yielded
      no disk path). Resolved paths are deduped in drop order.
    - **`WorkspaceBarDropZone` (`packages/assistant-ui/src/workspace-bar/`)**
      wraps the bar's existing chips ONLY when `onDropItems` is supplied
      (app-shell's `useFolderDrop` decides that from the bridge + `connectPath`
      capabilities) — no wrapper, no ring, no listeners on web. The `'Files'`
      MIME-type gate (`dragCarriesFiles`, checked BEFORE `preventDefault()`)
      is byte-identical to `notes-vault-panel.tsx`'s copy of the same name —
      intentionally not shared into a module for one function, but both sites
      carry a cross-reference comment because that gate is the
      security-relevant part of both surfaces (it is what keeps an internal
      pragmatic-drag-and-drop thread-tab drag from being consumed): if one
      copy is ever hardened, check the other. The drag-leave ring guard reads
      `event.relatedTarget` rather than the vault panel's
      `currentTarget === target` check: that check only holds up because the
      vault panel's drop surface has few children, but the bar is full of
      chips, and a dragleave bubbling off any one of them would otherwise
      flicker the ring. The wrapper is a bare `<div>` with TWO a11y
      suppressions, deliberately not a labelled `<section>`/landmark: chips
      already carry their own accessible names, this exact bar already
      rejects an extra grouping level for that reason (see the composer bar's
      own container comment, `workspace-bar.tsx`), and the wrapper exists
      only to catch a pointer gesture AT users cannot perform — the keyboard
      path is the Folder chip's Add folder… action.
    - **`useFolderDrop` (`workspace-connect/use-folder-drop.ts`) chains the
      SAME thread-attachment step Add folder…/Add recent… run after their own
      successful mount** (`recordAddedAsSecondary`, injected in from
      `use-workspace-bar.ts` since this hook has no thread/database context
      of its own) — a review finding: routing a drop through `connectPath`
      alone mounts the folder globally but leaves the bar showing no trace of
      it, on either outcome. Multiple dropped folders connect ONE AT A TIME,
      not concurrently: `addRootDirectoryByPath` shares a loading flag and a
      "most recently mounted becomes focused" outcome across calls, so firing
      them concurrently makes both non-deterministic (order stops matching
      drop order). A refused connect (`connectPath` resolves `null`) records
      nothing and chains no `recordAddedAsSecondary` call — `connectPath`
      already toasted its own refusal reason, so nothing here fires a second,
      differently-flavored notice on top of it. A drop that mounted
      everything cleanly toasts NOTHING, matching Add folder/Add recent's own
      silence on success — the chip appearing IS the feedback.
  - Reveal: the chip NEVER hardcodes an OS name. `WorkspaceBarProps.reveal`
    pairs `{ label, onReveal }` so supplying a handler without a label is a
    type error, and app-shell feeds it the platform-aware `revealLabel()`
    exported from `@brainstrike/file-explorer-ui/context-actions`.
  - Branch chip: `window.git.status` supplies the primary root's
    branch/detached, ahead/behind, and dirty-dot state — no polling. The dot's
    checkout-status read refetches on BOTH live-refresh signals: every accepted
    `changes:invalidated` git-metadata push AND the primary root's own git-scope
    nonce (`selectGitScopeRefreshNonce`), which is what carries WORKING-TREE
    edits. Metadata pushes report topology only, so on that nonce alone the
    dirty dot went stale the moment a file changed without a branch operation.
    The interactive menu also reads `window.git.repository` and its own
    `window.git.status`, then reuses the Git workbench's
    `buildBranchSwitchModel`: local branches stay in repository recency order,
    the current branch remains identified, and a branch held by another
    worktree shows `Worktree: <name>` and an explicit disabled reason. The
    shared switch gate derives dirty state only from tracked porcelain entries,
    so an untracked-only checkout remains switchable while staged or modified
    tracked files disable direct switching. The chip's dirty dot still reflects
    all porcelain entries. A disabled dirty row offers a separate `Switch in a
    new worktree` menu item only when `onSwitchInNewWorktree` is supplied; the
    later W3 Mode-Chip/worktree-service layer will supply that optional
    capability. Until then app-shell omits the callback, so the disabled reason
    stands alone with no worktree action. Direct switching and branch creation
    call the existing `switchBranch` / `createBranch` bridge paths without a
    fresh client-side status pre-check; the bridge result is the source of truth,
    and a returned or thrown mutation failure is logged and surfaced as a
    destructive toast. Fetch is offered only for a discovered default remote,
    and the call names that remote explicitly rather than relying on git's
    default. After a successful mutation, the hook
    refreshes the git inventory and advances its own reload nonce so it re-reads
    repository and status topology. Unlike the dot, the switcher's own
    repository/status load is keyed only on `anyInvalidationNonce` plus that
    post-mutation reload nonce — NOT on the root's git-scope nonce. An external
    working-tree edit to a tracked file can therefore leave the switch gate's
    tracked-dirty read stale until the next metadata push or successful
    mutation. The load is self-contained (BST-1452 M2): it fires its own
    `window.git.status` read unconditionally, concurrently with the
    workspace-bar dot's independent status read, rather than waiting on that
    other hook to resolve first. When that status read reports a non-repository
    primary root, the switcher stops there — it performs the status probe
    only, issues no `window.git.repository` read, and logs no warning, since
    "this folder isn't a repository" is an expected outcome, not a failure.
    There is no empty-list fallback: a failed menu repository/status
    read is logged and leaves the status chip non-interactive. The chip remains
    desktop-only and is absent for a non-repository root or a failed checkout-
    status read; that failure is logged and NEVER rendered as "clean". It is
    withheld whenever `primaryRoot` is absent, so a branch never renders with
    no folder beside it. Both live-refresh signals depend on the main-process
    git inventory having ARMED a watcher for that root's repository, which only
    happens inside an inventory build — so roots registered after app-ready are
    nudged into discovery by `use-roots-reconciliation.ts` calling
    `changes.inventory({ maxAgeMs: 0 })` once per registration (BST-1397; see
    "Discovery refresh on root registration" in
    `docs/agents/changeset-diff.md` § REFRESH SEAMS). The forced option is what
    makes the nudge reliable: it guarantees a build that started after the
    registration, so the TTL cache and in-flight coalescing cannot serve back a
    snapshot that predates the new `roots` row. Without that nudge a mid-session
    Add Folder / Recents root gets no metadata push at all and the chip only
    updates on reload.
  - **Mode chip (W3, BST-1390): Local / Worktree [D1].** Local means the
    thread works in the primary root's own checkout; Worktree means an
    isolated linked worktree BrainStrike created, recorded in
    `brainstrike_worktrees`, mounted as a `kind='worktree'` root through the
    managed-worktree grant (see `roots.kind = 'worktree'` above), and bound as
    the thread's PRIMARY through the same `operatingRoot*` metadata triple
    `persistThreadRootBinding` writes — which is what makes the server's
    existing `boundWorkspaceRootId`-first ordering
    (`orderWorkspaceRootsForRuntime`) resolve hooks, tools and the terminal
    into the worktree with NO server change. "Cloud" is deliberately omitted,
    not stubbed — there is no environment story to explain. A non-repository
    primary root gets a DISABLED chip stating "Not a git repository", never an
    absent one (`packages/app-shell/src/hooks/use-worktree-mode.ts`). The
    chip's own list of worktrees comes from the `window.worktrees` bridge's
    `list()` (the ledger + a live `git worktree list` merge in
    `apps/desktop/src/assistant-server/worktree-service.ts`), NOT from
    `window.git` inventory, so it refreshes independently of the Branch
    chip's git-status read above — eagerly on mount, and again after every
    create/select/archive mutation. The existing-worktree picker
    (`worktree-picker-dialog.tsx`) lists EVERY worktree the ledger reports —
    including ones another tool created (`~/.codex/worktrees`,
    `~/.cursor/worktrees`), labelled by tool — each usable or disabled with
    its reason and, where remediable, a "Grant access…" button that opens the
    OS folder picker. "New worktree…" opens a create sheet
    (`worktree-create-dialog.tsx`) with a read-only Location, a `bs/<name>`
    branch default (editable, or "Detached — name the branch later"), and a
    Setup summary; a creation failure renders IN the sheet and leaves the
    thread on Local rather than partially switching it. Both dialogs are
    written INSIDE `ModeChip`'s own JSX rather than hoisted, so their
    `<Dialog>` nesting depth stays 1 and their panel paints at `z-[51]`
    (`packages/ui/src/layers.ts`) — above nothing else the chip owns, since
    the dropdown menu that opens them (`z-[70]`, `POPUP_LAYER_CLASS`) has
    already closed by the time either one mounts. **Live-verified gap
    (BST-1390, not yet filed as its own follow-up):** closing either dialog
    with Escape leaves focus on `document.body` rather than returning it to
    the Mode chip trigger — confirmed against the running app, not assumed;
    fix or file before relying on keyboard flow through this chip.
- **Root-header context menu (BST-1393, spec §7) — SHIPPED, the v1 DEFERRED
  ruling above is CLOSED.** `packages/context-actions/src/types.ts` carries a
  `workspace-root` ContextTarget kind (`displayName` · `isMain` · `path | null`
  · `rootId`), adapted by `workspaceRootToTarget`
  (`packages/file-explorer-ui/src/context-actions/workspace-root-target.ts`),
  which normalizes a web FSA handle's name-as-path to `null` so path-shaped
  actions hide by DATA rather than by platform. Both the forest sidebar's
  `RootSectionInner` and the SINGLE-ROOT layout's own header row wrap ONLY
  their header in `ActionContextMenu` — never the tree pane, which owns its
  own — so the two menus stay siblings rather than nesting. A single-root
  workspace (the primary, one-folder scenario) has its own trigger row
  (`data-testid="single-root-header-row"`), not just the forest sections; the
  claim/reset/local-actions/focus-restoration protocol is shared by both
  through `packages/file-explorer-ui/src/shell/use-root-section-context-menu.ts`
  (`useRootSectionContextMenu` / `useSingleRootHeaderMenu`) rather than two
  independently-maintained copies.
  - Six items, three owners. GLOBAL registry: `workspace-root.copy-path`
    (`clipboard`) and `workspace-root.reveal` (`fs.reveal`). SURFACE-LOCAL in
    `file-explorer-ui` (`workspace-root-local-actions.ts`):
    `workspace-root.set-as-main` and a STAGED `workspace-root.disconnect`.
    Disconnect… is present only when the surface actually has a way to
    disconnect (`onDisconnect` is optional and OMITS the action when absent —
    mirrors the header's own X button, never a silently-inert visible item).
    Set as Main's dep returns an `ActionOutcome`: `setMainRoot` warn-and-no-ops
    for an id `activeRootIds` doesn't recognize (a legacy path-identity root),
    so the surface checks `activeRootIds.includes(target.rootId)` first and
    reports `{ ok: false }` rather than the click silently doing nothing.
    INJECTED by app-shell through `FileExplorerPanel`'s `rootActions` prop
    (the `selectionActions` precedent): `workspace-root.open-in-terminal` (the
    BST-1457 `terminal-target-store` seam — a mounted root IS its own cwd, so
    `cwd` and `rootId` name the same folder here) and
    `workspace-root.new-thread-here`.
  - **"Set as Main", not "Make primary" (BST-1393 ruling R1).** This surface
    changes the workspace-wide MAIN root (`setMainRoot`, `activeRootIds[0]`) —
    the role this same header already renders as its "Main" badge. The
    workspace bar's "Make primary" is a DIFFERENT operation with a different
    writer (the thread's `operatingRoot*` metadata triple) and is untouched.
    Do not merge the two vocabularies.
  - "New thread here" goes through `useCreateThreadInFolder`
    (`packages/app-shell/src/hooks/use-create-thread-in-folder.ts`), which is
    the threads panel's own folder-bound creation extracted so BOTH surfaces
    keep ONE writer of the `operatingRoot*` triple: one `createThread`, then
    ONE metadata write (the repository rejects a partial triple).
  - **Disconnect… dialog-focus ordering — LIVE-VERIFIED (BST-1393 L5 CDT,
    2026-08-27):** `Disconnect…` stages a modal (`DisconnectRootDialog`) from
    inside `ActionContextMenu`'s `onCloseAutoFocus`; Radix's exit animation
    means the menu's REAL unmount (and that focus-restoration callback) fires
    AFTER the dialog has mounted and autofocused, so `onCloseAutoFocus` skips
    its own restoration while the dialog is open. jsdom cannot observe the
    ordering (synchronous unmount); the live CDT run sampled
    `document.activeElement` immediately, at 300 ms and at 800 ms after the
    Disconnect… click and found focus INSIDE the dialog (a BUTTON) at every
    sample, with no flicker back to the header toggle — the guard holds
    against the running app, and the desktop e2e's Disconnect case now polls
    the same containment. Escape closes the dialog with the root still
    connected.

**Known issue (out of scope here, filed separately):** nothing ever
transitions `roots.status` off `'live'` (`reconcileRoots` never UPDATEs), so
the server can still serve DISCONNECTED folders in `workspaceRoots`; this
feature only reorders. The client's `activeRootIds` contains only MOUNTED
roots, which is why the client-declared main avoids the phantom-root problem
by construction.

**Paired tests:**
`packages/file-explorer/src/actions/__tests__/active-root-actions.test.ts`
(setMainRoot semantics + removal promotion + `setActiveRoots` restore-order
preservation),
`packages/file-explorer-ui` `root-section-header.test.tsx` +
`file-explorer-sidebar.test.tsx` (badge/focused/tooltip + forest wiring),
`packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-runtime.test.ts`
(mainRootId/mainRootPath wire fields) + `workspace-root-status-item.test.tsx`,
`packages/agent/src/__tests__/workspace-root-manifest.spec.ts` (bounds,
zero/unavailable state, exact ids, Main/Focused priority) +
`mastra-tool-execution.integration.spec.ts` (turn-one qualified read),
`apps/desktop/src/__tests__/assistant-server/agent-stream-init-and-memory.integration.test.ts`
(client root inventory replacement),
`packages/assistant-ui/src/__tests__/workspace-bar.test.tsx` +
`packages/app-shell/src/__tests__/use-workspace-bar.test.tsx` +
`packages/app-shell/src/__tests__/use-thread-checkout-status.test.ts` +
`apps/desktop/src/__tests__/ipc-domains/workspace-root-registry-recent-roots.test.ts`
(ledger + `addRootByPath` authorization) +
`apps/desktop/e2e/workspace-bar.desktop.test.ts` +
`apps/web/e2e/workspace-bar.test.ts` (chips, recents re-mount, web omission),
`packages/assistant-ui/src/__tests__/mode-chip.test.tsx` +
`worktree-picker-dialog.test.tsx` (Mode chip rendering, picker rows) +
`packages/app-shell/src/__tests__/use-worktree-mode.test.ts` (bridge wiring,
create/select/archive, disabled reasons) +
`apps/desktop/e2e/worktree-mode.desktop.test.ts` (real git worktrees, real
ledger, create/use/archive against the built app),
`apps/desktop/src/__tests__/assistant-server/workspace-roots.test.ts`
(orderWorkspaceRoots + enrichment reorder), and the
`hooks primaryCwd follows the declared main root` describe in
`apps/desktop/src/__tests__/assistant-server/hooks/server-composition.integration.test.ts`.
**The W6 connect-folder seam + Finder drop** (BST-1393, spec §7 / §4.1 [D7]):
`packages/app-shell/src/__tests__/workspace-connect-bridge.test.ts` (bridge
capability resolution + the exact-set `WorkspaceOpenOrigin`/required-method
proofs) + `use-connect-folder.test.tsx` (S1 refusal remedy, IPC-envelope
stripping, the FSA-capability `openPicker` gate) +
`workspace-connect-host.test.tsx` (malformed-request rejection, subscription
wiring) + `application-file-menu.test.ts` (File menu → `connectPath`),
`packages/app-shell/src/__tests__/extract-dropped-folder-paths.test.ts`
(drop-tick synchronicity falsifier, the three separately-counted
non-outcomes, dedup) + `use-folder-drop.test.tsx` (sequential connect +
`recordAddedAsSecondary` chaining, the refused-connect-records-nothing case,
skip/unreadable/unresolved toast copy) +
`packages/assistant-ui/src/__tests__/workspace-bar-drop.test.tsx` (the Files
MIME gate, the relatedTarget leave guard, capability gating by omission on
web) + `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`
(`window.workspace` preload surface).

When changing this flow, update this section and the paired tests.

---

## DIRECTORY HANDLE `rootId` PROPAGATION (REBUILT CHILD HANDLES)

Distinct from the MAIN/FOCUSED concept above: this is the durable `RootId`
UUID stamped on a `DirectoryHandle` (`DirectoryHandle.rootId?: RootId`,
`packages/types/src/file-system.ts`) when a folder becomes a registered root.
It self-identifies the handle for capability/mount resolution
(`apps/desktop/src/ipc-domains/workspace-root-mounts.ts`
`WorkspaceRootMountTable.resolveForRead`)
and collision-proof folder-state keys — two same-named web roots share a
`path` (the FSA API hides the absolute path) but never a `rootId`.

**The invariant:** every function that rebuilds a child `DirectoryHandle`
during recursive directory traversal — instead of reusing a handle the
adapter returned — must carry `rootId` forward with parent-anchor fallback:

```ts
const entryHandle = entry.handle as Partial<DirectoryHandle> | undefined;
const rootId = entryHandle?.rootId ?? parent.rootId;
return {
  /* ...other fields... */
  ...(rootId === undefined ? {} : { rootId }),
};
```

A self-identifying child (its own handle already carries a `rootId`, e.g. a
nested registered root) wins over the parent anchor. The parent-anchor
fallback matters because on web, adapter child handles are raw
FileSystemAccess handles with no `rootId` of their own
(`packages/file-system/src/adapters/web-adapter.ts` `readDirectory`) — so
forwarding-only logic (checking `entryHandle?.rootId` but never falling back)
silently drops identity at every depth below the root. `platform` uses the
same anchor-with-fallback shape at every site below; `rootId` must match it.

**Enumerated rebuild sites (six, as of BST post-#2514 follow-up):**

1. `packages/file-explorer/src/read-full-file-tree.ts` — `createChildDirectoryHandle`
2. `packages/file-explorer-ui/src/utils/parallel-directory-walker.ts` — `buildChildHandle`
3. `packages/app-shell/src/background-indexing/workspace-collection-sync-scan.ts` — `toDirectoryHandle`
4. `packages/file-explorer-ui/src/utils/lazy-tree-loader.ts` — `buildDirectoryHandle`
5. `packages/file-explorer-hooks/src/use-file-tree.ts` — the directory-handle literal in `processSingleEntry`
6. `packages/file-explorer-ui/src/utils/process-directory-entry.ts` — `processDirectoryEntry`

Sites 1–4 were fixed together (root-identity preservation across traversal);
sites 5–6 were the same bug class, missed because neither ships in an app
today (`useFileTree`/`useFileExplorer` from `file-explorer-hooks` is not
imported by `apps/desktop` or `apps/web`; `processDirectoryEntry` had only
test callers) but both are public package exports. **Before adding a seventh
rebuild site, check this list — the class has recurred four times.**

**Behavior decision (pinned, desktop):** `WorkspaceRootMountTable.resolveForRead`
(`apps/desktop/src/ipc-domains/workspace-root-mounts.ts`) short-circuits to its
own `this.mounted.get(rootId)` before ever consulting path containment. With
nested mounted roots, a read whose `rootId` was inherited from an outer
traversal anchor therefore resolves against the OUTER mount, not the
innermost path-matched one `findForAbsolutePath` would otherwise
pick. This is the intended behavior, not a side effect: reads made during a
traversal started from root R are authorized and attributed under R's
capability. A self-identifying nested root still wins, because the caller
supplies its own `rootId` rather than relying on the parent-anchor fallback.
Pinned by `apps/desktop/src/__tests__/ipc-domains/workspace-root-registry.test.ts`
("an inherited rootId anchors a nested read to the traversal (outer) root").

**Do not conflate `DirectoryHandle.rootId` with `IFileNode.rootFolderId`** —
the latter is a folder-state bookkeeping key (defaults to `handle.path` when
no durable id is threaded in) and is a different value in the legacy/no-id
case. Threading one where the other belongs re-introduces exactly this bug
class under a different name.

When adding a seventh rebuild site or changing this invariant, update this
section and its paired tests.

---

### Persona Settings host checks (BST-1727)

The canonical [persona Settings host-check contract](assistant-subagents.md#persona-settings-host-checks-bst-1727) covers validated scan results, model/tool availability, and request-dependent scope.



### Persona edits and admitted child decisions (BST-1727)

User persona scans resolve the profile for a fresh delegation. Once a child is
admitted, its effective tool scope, instructions, mode, model pin and clamped
step budget are stored with that delegated conversation. Editing, disabling or
removing the file affects fresh root turns, while pending child approvals and
questions resume with their admitted configuration, including after host reload.
Current host permissions and available model credentials still apply. Invalid
stored identity/configuration fails visibly rather than selecting a replacement
profile. Cross-provider credentials are resolved from the host on resume and
never written into the profile snapshot. No new persona store/reset registration
is added. Implementation and production evidence live in assistant-subagents.md's
admitted configuration section.

### Delegated workspace checkpoint ownership (BST-1726)

The child input processor awaits its existing host admission, including a
turn-start shadow snapshot before first execution. Child resume/recovery retains
that baseline; recovery before execution finishes any roots whose capture was
interrupted. A legacy child with an existing run but no baseline remains
unrestorable; capture failure records the existing failed-capture sentinel. No
new content journal or persistence store is introduced.

The child header identifies the shared workspace and the per-path file-write
serialization mode. No isolated worktree or automatic merge is implied.
The shared child view provides the existing checkpoint context for its child
thread and refreshes it on terminal host updates. Revert uses the ordinary
conflict-checked IPC operation and survives reopening/reload. It restores only
the selected journaled paths; independent user files remain untouched.

Paired proofs: `assistant-tools-write-staleness.integration.test.ts` uses real
sibling workspace tools and temporary Git repositories,
`delegated-workspace-snapshot.integration.test.ts` covers baseline recovery and
failed/legacy captures, and `delegated-worker-write.desktop.test.ts` opens the
real child, restores its created file, and reloads without replaying the worker.

Child file-mutation callbacks retain Mastra's per-execution `abortSignal` as well
as the host-leg signal. After waiting for the canonical path lock and reading
before-state, they check both immediately before write/replace/delete/rename.
Stopping one child cannot start its queued mutation when the lock is released.
A filesystem operation already started still settles its existing checkpoint
and index attribution; Stop does not roll back completed edits. The real path-lock
cases in `assistant-tools-write-staleness.integration.test.ts` cover all four
mutations, preserved completed bytes, and an unaffected sibling.

A child's explicit bound root also wins over the currently focused folder on
non-Git workspaces. Disconnecting that root is a visible error; neither a new
folder focus nor unavailable worktree capability authorizes switching roots.
The same integration file proves both actual filesystem destinations.


The native executor passes a durable execution thread separately from the
read-state scope; a DB-less scope sentinel never becomes checkpoint ownership.
Tool input cannot choose that identity: strict native schemas reject extra
identity fields and the common execution reader reads only the second, host-owned
context argument. Initial and approval-resumed writes are paired integration
cases, with a distinct host-leg checkpoint run for each. Already stopped native
mutations reject before acquiring a path lock; the post-lock check remains
necessary when cancellation arrives while waiting.

All live desktop initial, approval and suspension-resume requests share the
`handleAssistantPost` initializer and its snapshot dependencies; background work
and active child input retain that runtime. Snapshot Git failure records a
failed-capture sentinel. Admission does not swallow ledger/database failures: a
child must not begin work after its baseline ownership could not be established.
Post-effect checkpoint recording retains its existing error-reporting contract.

Child workspace breadcrumbs require the same FileExplorerProvider as AppLayout.
The live/reloaded child tests mount that provider rather than replacing its
selector. A disconnected bound root displays an explicit unavailable-folder
label, never an opaque root identifier or a replacement workspace.

### Managed opaque workspace effects (BST-1726)

Finite native shell and skill processes acquire an exclusive lease on their
canonical declared workspace root until actual process settlement. Queueing and
execution share the existing call deadline; an expired waiter never spawns. Native file
mutations acquire a shared workspace lease around their existing ordered
per-file locks, including staleness/capture/write/checkpoint/index settlement.
Overlapping parent/child root paths conflict; disjoint roots and disjoint file
mutations without an opaque owner retain concurrency. Queued cancellation
refuses execution before any effect. Skill runtime resolution plus lease wait
continues to share its original timeout budget. Expiry names both runtime preparation
and workspace ownership, including a resolver that settles only after the budget.
Admission expiry and cancellation
produce trusted model-visible no-execution errors; a session conflict preserves
the owning session ID and process-exit requirement through the ordinary tool guard.

A long-lived **delegated** command session retains its exclusive lease until
PTY exit. A conflicting managed edit/process fails visibly with the session ID
and the requirement to wait for process exit before editing; it is never queued indefinitely
or silently applied later. This is a stop/edit/restart workflow when the child
chooses a persistent process. The existing Command sessions surface can stop
the named session, and selected child Stop joins the sessions owned by those
host-observed native child identities before acknowledging completion. That
ownership lives in the existing process manager, not a parallel registry.
Lease release follows actual exit; a failed stop cannot release uncertain work.
A root/global disposal timeout retains the exit observer even after inventory
removal, so a later actual exit releases ownership without exposing live work. The
conflict message does not direct the user to a control that has already retired.

Ordinary root/user command sessions retain their existing dev-server/edit flow;
this lease does not claim to serialize arbitrary user-owned background servers
or external processes. Shell cwd checks remain the existing containment rule,
not a sandbox: command bodies are unrestricted after permission. Remote MCP
servers own their own filesystem scope and cancellation semantics; arbitrary
tool input or metadata never establishes client-side workspace confinement.
The real HTTP MCP worker fixture proves an approved server-owned disposable
file effect once, preserves dirty/sibling files, refuses replay, and prevents
execution when the pending worker is stopped before dispatch.

Native delegated thread IDs may exceed a filesystem/ref component length at
three levels of recursion. Snapshot ownership retains the exact native ID in
the existing ledger and commit metadata; the Git lineage key is bounded as
documented in changeset-diff.md. Never increase root directory validation limits
or truncate native identity to make a recursive child snapshot fit. Real delegated
capture/recovery and selected-path restore preserve independent user/sibling files.
