# Workspace Context Features: Prompt Workbench, Instructions Injection, Slash Commands, Agent Skills, Edit Checkpoints, Root Identity (Main vs Focused)

> Read before changing the prompt library, AGENTS.md/CLAUDE.md injection, user
> `/commands`, Agent Skills, the edit-checkpoint journal, read-before-write, or
> Main/Focused root identity. Rules here are true now; the record behind each is in
> `workspace-context/<topic>.md`.

## PROMPT WORKBENCH

- The prompt library is a surface in the agent sidebar (Threads → Database →
  Prompts), not a route. PGlite is its only store — never a localStorage parallel
  path — and bootstrap's initial `list()` is authoritative and fatal on failure.
- Render the loading placeholder while `useDbInitializationStatus()` is
  `idle`/`initializing`; reserve the "requires an initialized database" alert for a
  genuine init failure.
- Prompt vectors live under the dedicated singleton prompt profile; never add prompt
  records to `embedding_sets`. Saved items embed as documents, live composer context
  as queries, vector failure surfaces with no lexical fallback, and a profile
  declaring `l2` or `ip` fails closed.
- Serialize indexing passes and search-embedder transitions; run no embedding
  inference and fail WebGPU init/recovery closed while hidden; merge async
  save/list completions against the latest authoritative snapshot, never the render
  that started them.
- Agent actions flow through the thread-keyed in-memory FIFO
  `assistant-composer-command-store.ts`, acknowledged after application and
  registered with factory reset. Snippets append, prompts replace, nothing
  auto-sends, and a synchronous in-flight guard keeps repeat activation from staging
  twice or duplicating threads.
- Apply a runnable prompt's model only once it is enabled and its provider
  available, validating call settings strictly with `maxTokens` normalized to
  `maxOutputTokens`; unknown settings, conflicting aliases and unavailable targets
  fail before mutating a thread.
- Old-provider model settings never leak across a provider switch; on a
  same-provider change, explicit per-thread settings beat provider defaults and
  prompt-stored settings beat both. Edits preserve stored ratings and non-editable
  settings, replacing only the five canonical runtime settings.
- Validate rendered prompt text as non-whitespace before runtime selection, thread
  creation, staging or usage writes, and mirror assistant-ui's authoritative composer
  state, including programmatic clears — never textarea DOM events alone.
- Create a new-thread action's durable thread with its final title atomically before
  activation, after any in-flight initial resource load settles.
- Once persistence or staging succeeds, later indexing, list-refresh or usage-count
  failures are secondary warnings: surface them, never reject the completed action.
- Factory reset tolerates only an explicitly missing legacy `prompt_items` relation;
  any other prompt deletion failure aborts before close/VACUUM and stays visible.
- `connected-prompt-manager.tsx` owns DB/model/thread/vector wiring,
  `prompt-workbench-panel.tsx` the interaction layer, `prompt-template.ts` explicit
  `{{variable}}` resolution; load the manager lazily so that graph stays out of the
  initial app-shell bundle, and render a stored unavailable model as an explicit
  disabled selection.

Evidence: `workspace-context/prompt-workbench.md`. Paired tests live in
`packages/db`, `packages/app-shell`, `packages/ui`, `packages/vector-management`.

---

## WORKSPACE INSTRUCTIONS CONTEXT (AGENTS.md / AGENT.md / CLAUDE.md)

Each mounted root's top-level instructions file is injected as a PREPENDED `system`
message every turn. Desktop-only, capability-gated — no `isElectron()`.

- Inject at the same request boundary as `injectReferencedFilesContext`: referenced
  files first, workspace instructions LAST, so the general conventions land frontmost.
- Per root, first match wins over `AGENTS.md` → `AGENT.md` → `CLAUDE.md` at the
  root's top level, read through `readWorkspaceTextFile`'s containment, size and
  binary guards — add no raw-fs read path — with headings qualified by
  `root.displayName`.
- Budgets mirror referenced files (`MAX_CONTEXT_FILE_CHARS`,
  `MAX_CONTEXT_FILES_TOTAL_CHARS`). The aggregate is a HARD ceiling: a file that
  would overshoot it counts as omitted with an honest note, and truncation never
  splits a UTF-16 surrogate pair.
- Skip injection entirely for provider `'local'`. Why: the built-in Gemma's whole
  context budget is 8,192 tokens.
- `findRootContextFile` returns `{kind:'found'|'none'|'error'}`. Only an ENOENT
  candidate advances to the next name; a present-but-unreadable one short-circuits to
  `'error'`, which injection logs and omits — never a prompt note, never a fabricated
  absence — and Settings shows as "Unavailable" with the detail.
- THRESHOLD-HYBRID policy, never a silent drop: a file inside the per-file budget
  auto-injects whole with no note; an oversized file injects only under an explicit
  per-root opt-in, truncated with an honest note, and otherwise appears in Settings
  as detected-but-not-injected rather than as prompt text. A master toggle
  (default ON) covers the feature.
- Oversized opt-in is defined only for DB-backed roots, so a DB-less legacy root's
  opt-in is un-settable and its oversized file stays un-injected.
- Key the preference `{ masterEnabled, oversizedOptInByRootId }` by durable DB
  `roots.id`, store only `true` opt-ins, and reset it through the direct-call seam in
  `factory-reset-helpers.ts`.
- `runtimeData.workspaceInstructionsPreference` is a PREFERENCE, not a security
  boundary: the server reads the renderer snapshot directly, but drops a malformed
  field with a warn and applies the fail-safe default (master ON, no opt-ins).
- The Settings scan (`window.contextFiles.scan()`, channel `context-files:scan`)
  reuses the injection path's `findRootContextFile`, so its status and oversized
  decisions are byte-identical to injection; a rejected scan renders a distinct,
  logged error state with Retry, never the empty "no folders" state.

Default-ON with no per-root trust gate is an accepted risk, since
referenced-files injection is already ungated and the permission engine's `ask`
defaults keep injected text from driving mutations; web is deferred for want of a
workspace-tool bridge. See ADR-0016.
Evidence: `workspace-context/workspace-instructions.md`.
Guard: `apps/desktop/src/assistant-server/__tests__/workspace-instructions-context.test.ts`,
`workspace-instructions-scan.test.ts`,
`apps/desktop/src/__tests__/ipc-context-files-handlers.test.ts`.

---

## SELF-IMPROVEMENT SIGNAL INJECTION (BST-1241)

Desktop may prepend a compact summary of the previous 24 hours' wasteful tool
behavior to a fresh run. Persisted opt-in, default OFF, strictly parsed server-side
and failing safe to OFF.

- Execute the app-owned `SELF_IMPROVEMENT_SIGNAL_SQL` constant, never a
  workspace-scanned lens; a parity test pins the shipped repository lens byte-equal
  to it. Why: a mounted repo can shadow that lens file, and running its copy would
  let repository-authored SQL shape a system message.
- Inject only on the fresh-generation path, between explicit skill activation and
  workspace instructions, with provider `local` excluded and approval/resume legs
  keeping their early returns. Because every injector prepends, the final order is
  workspace instructions → self-improvement signal → activated skills → referenced
  files → conversation.
- Treat the query's ROWS as untrusted even though its SQL is app-owned: telemetry
  `tool_id` is persisted verbatim from arbitrary MCP server strings, so restrict each
  rendered id to `[A-Za-z0-9_.:-]` capped at 40 characters. Worst-case block size is
  then structural and test-pinned; there is no runtime truncation path.
- Anchor the 24h window to the top of the hour and memoize parsed rows per hour-key
  in main, so the cached prompt prefix is invalidated at most hourly. Memoize an
  empty no-waste hour; never memoize a failure.
- Query failure, malformed rows or an unexpected column contract logs a warning and
  injects nothing; zero qualifying waste logs at debug; every no-op preserves the
  original message-array identity.
- The companion experiment-enrollment preference rides the same renderer seam: a
  persisted `{ experimentId, variant }` pair (default null, factory-reset to null)
  attached only when BOTH fields are set. It is attribution metadata and never
  changes runtime behavior.

Remove the feature after a meaningful sample if truncation and zero-match
rates do not improve over equivalent windows. Evidence:
`workspace-context/self-improvement-signal.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/self-improvement-signal-context.test.ts`.

---

## `.brainstrike/` SCAN CONVENTIONS — the family

Three features scan per-root plus `~/.brainstrike/` config directories; a fourth
reuses one of these two shapes rather than inventing a third:

| Feature | Dir | Loader | Shape |
| --- | --- | --- | --- |
| /commands | `commands/` (+ `.claude/` compat tiers) | `user-slash-commands-loader.ts` | recursive, `:`-namespaced, invalid dropped w/ log |
| personas | `agents/` | `user-personas-loader.ts` | flat, `entries` + visible invalid, first-id-wins |
| lenses | `lenses/` | `lens-loader.ts` | mirrors personas exactly; grammar in `assistant-contract/src/lenses.ts`; surfaced via `querySelf` `listLenses`/`lens` (see `docs/agents/agent-self-query.md` § Lenses) |

### Four rules every flat-scan loader must follow (BST-936)

1. Reserve the id from the FILENAME, before reading or parsing, through ONE exported
   contract function shared by loader and parser, so the reserved key and the real id
   cannot drift. Reserve through the FULL id gate — personas `resolveUserPersonaId`
   (derivation plus built-in collision), lenses `deriveLensId` — and reserve nothing
   for a filename that derives no valid id.
2. Count ENTRIES (valid plus invalid) against the count cap, not accepted items, and
   REPORT exhaustion per directory. Why: the cap is destructive, so an earlier root
   can consume the budget before a later tier is read at all.
3. Derive the `listDir` `maxEntries` bound as `cap * 2 + 1`; it counts every directory
   entry, so deriving it from the item cap lets junk evict real files. Land every
   partially-scanned directory in `incompleteDirs` with its reason, rendered AMBER —
   red is reserved for "you must fix a file".
4. Render suppressed duplicates as visible `status: 'shadowed'` entries carrying
   `shadowedBy: { absPath, sourceRootId? }`, naming the file that WON, as
   `skill-scan.ts` already does. A shadowed file is its own muted state, not an
   error, and `listLenses` prints a `SHADOWED` line naming the winner.

Evidence: `workspace-context/flat-scan-loaders.md`.

## USER-DEFINED SLASH COMMANDS

Prompt-template `/commands` authored as `*.md`, projected into the SAME composer "/"
menu as the built-in app commands — a second kind of entry in the existing
`SlashCommand[]`, no new autocomplete. Desktop-only by construction: discovery reads
disk in main and web's hook returns `[]` (capability-gated).

- Scan `*.md` in PRIORITY order, highest first, first-name-wins:
  `<root>/.brainstrike/commands/` per mounted root, `~/.brainstrike/commands/`,
  `<root>/.claude/commands/`, `~/.claude/commands/`. Recurse with directory
  namespacing (`git/commit.md` → `git:commit`); a cross-root collision keeps the
  first-mounted root and warns once.
- Resolve roots via `loadWorkspaceRootsFromDatabase` (durable `roots.id`, never a raw
  path); a DB failure still loads GLOBAL commands, logged.
- Treat command files as UNTRUSTED repo content and bound the scan:
  `MAX_USER_COMMAND_FILE_CHARS` skips an oversized file with a visible warn-once and
  `MAX_USER_COMMANDS` ignores the rest with a warn — never a silent truncation, never
  a scan-killing error.
- Open the canonical mounted root as a native `SecureRoot` and keep enumeration and
  bounded reads relative to that pinned handle, so roots cannot borrow one another's
  trust or lose a parent-path swap race. There is no path-based fallback; missing
  native support fails closed.
- Parse frontmatter with the hand-rolled `parseUserCommandFile` (no YAML dependency)
  for `name`/`description` only, tolerating unknown keys and Claude Code
  multiline-YAML continuation lines and stripping a leading BOM; other malformed or
  unterminated frontmatter fails CLOSED with a visible error. No frontmatter means
  the whole file is the template; the id is path-derived and `name` is only a label.
- Merge via `mergeSlashCommands`, app commands first, DROPPING a colliding user
  command with a warn-once. Why: the pinned adapter's `onExecute` is find-first, so a
  listed collision would run the app command from the user's row.
- `execute()` reads the LIVE composer draft from the app-shell mirror, expands, and
  writes back with `mode:'replace'` and `removeOnExecute: true` — never auto-sends;
  no active thread raises a visible toast. Reload the list on mount, on mounted-root
  change, and on `visibilitychange`.
- Leave any unfilled `$ARGUMENTS`/`$N` token LITERAL as a visible placeholder the
  user fills before sending. Why: the pinned popover closes at the first whitespace
  after `/id`, so inline `/cmd args` capture is unreachable and the arg string is
  always empty at selection. Do not re-document inline args as working, and do not
  add send-time expansion.
- Expand in a SINGLE tokenizing pass, so substituted argument text is never
  re-scanned and a `$100` or `$1` typed as an argument survives verbatim.
- Convert template `@path` tokens into `:file[basename]{name=encoded}` directives via
  `encodeFileMentionId` and let the referenced-files pipeline resolve them;
  substitute args INSIDE a template `@…$1` path BEFORE serialization, so a `}` in the
  argument is percent-encoded and cannot truncate the directive.
- A root-scoped command binds to its `sourceRootId`; a global command binds to the
  single mounted root, else leaves the token literal. User-supplied `@` argument text
  stays literal.
- SECURITY HARD LINE: there is NO shell (!\`command\`) expansion, gated or not, ever
  — it passes through as inert text. Do not add it.

There is never shell expansion; web and namespaced popover grouping are deferred.
See ADR-0016.
Evidence: `workspace-context/user-slash-commands.md`.
Guard: `packages/assistant-contract/src/__tests__/user-slash-commands.test.ts`,
`apps/desktop/src/__tests__/assistant-server/user-slash-commands-loader.test.ts`,
`packages/app-shell/src/__tests__/use-user-defined-slash-commands.test.tsx`,
`packages/assistant-ui/src/__tests__/slash-commands.behavior.test.tsx`.

### MCP SERVER PROMPTS — the fourth slash-entry kind (BST-1592)

- Merge prompts published by connected MCP servers LAST into the same
  `SlashCommand[]`. Desktop-only by construction: `resolveMcpPromptBridge()` needs
  the visible-UI preload's `window.mcp` members, web returns `[]`, and a PARTIAL
  bridge is a defect the always-mounted host reports out loud.
- Ids are `mcp:<configuredServerId>:<promptName>` with `:` and `\` escaped in both
  components, because a non-injective id would drop a valid prompt; labels carry the
  raw title and server id, because two servers may expose the same prompt name.
- An argument-taking prompt opens a modal backed by `completion/complete`
  (`ref/prompt`); an argument-less prompt stages immediately. `prompts/get` runs only
  on that explicit action and writes to the composer DRAFT — never auto-sent, never
  eager model context.
- Re-check the pending selection and the live draft AFTER the await: a dismissed
  dialog stages nothing, and a draft edited meanwhile is APPENDED to.

Full contract, failure taxonomy and packaged proof:
`docs/agents/assistant-providers.md`. Evidence:
`workspace-context/mcp-server-prompts.md`.

---

## AGENT SKILLS (SKILL.md — agentskills.io spec)

Skills teach the assistant workflows by progressive disclosure: name and description
always in context, SKILL.md on demand, bundled references, scripts and assets read as
needed. Built on Mastra's canonical surface (`WorkspaceSkills`, `createSkillTools`,
`SkillsProcessor`, `formatSkillActivation`) over a brainstrike-owned engine, because
Mastra's own implementations are neither public exports nor bounded readers.
Desktop-only by construction; web builds no bridge or engine.

- PIPELINE RULING (do not relitigate): never attach the skill tools through Mastra's
  Agent-level `skills:` option. Fold `createAssistantSkillTools(workspaceSkills)`
  into the LOCAL tool map BEFORE `sanitizeTools`, so they traverse
  guards → hooks → plan mode → permission like every native tool, registered under
  Mastra's canonical UNNAMESPACED ids with `riskCategory:'read'`. Why: Agent-level
  auto-added tools land after `new Agent` and bypass that pipeline.
- Execute bundled scripts only through the deferred desktop
  `brainstrike.runSkillScript` tool: activated winning skill name, canonical
  `scripts/...` path, `node|python3|bash` runtime, structured argv, explicit mounted
  root and root-relative cwd. The trusted scan engine rejects absolute or traversal
  paths, disabled or shadowed skills, missing or list-unregistered scripts,
  runtime-extension mismatches, and unmatched Claude `allowed-tools: Bash(...)` rules.
  An extensionless script must declare a matching supported interpreter in its shebang;
  the same bounded content reader and all execution/approval checks still apply.
- Spawn direct argv, never a shell command string, through the shared
  bounded-output/process-tree lifecycle and the normal `execute:ask` gate. Pin a
  workspace-local skill to its owning durable root; a global skill may target any
  explicitly selected mounted root.
- On Windows, the Bash runtime resolves Git for Windows from its standard install
  locations or a Git `cmd`/`bin` directory on PATH. It never invokes PATH's bare
  `bash.exe` (which can launch WSL); missing Git Bash is an explicit tool error.
- Activation guidance routes mutation through native workspace tools, forbids shell
  heredocs, and carries `runSkillScript`'s own recovery path (`load_tool` by exact
  name, callable on the next step of the same response). Why: the tool is DEFERRED on
  hosted discovery runs, and a model checking its visible tools otherwise concludes
  it does not exist and works around via `executeCommand`.
- Reserve the guidance's space INSIDE the activation budget
  (`withBoundedActivationAndGuidance`), so an over-budget SKILL.md cannot have the
  whole guidance block truncated away.
- Discovery reads four tiers, highest first, first-NAME-wins:
  `<root>/.brainstrike/skills/` per mounted root, `~/.brainstrike/skills/`,
  `<root>/.claude/skills/`, `~/.claude/skills/`. A skill is a directory whose
  immediate `SKILL.md` carries valid YAML frontmatter; the scan is FLAT and bounded
  by `MAX_SKILL_FILE_CHARS`, `MAX_SKILLS`, `MAX_SKILL_DIR_ENTRIES`.
- Every candidate yields a visible entry: `ok` (with spec warnings), `invalid` (exact
  errors, fail closed) or `shadowed` (names its winner). Skills REQUIRE frontmatter,
  unlike `/commands`; `skill-validation.ts` MIRRORS @mastra/core's unexported
  `validateSkillMetadata` byte-for-byte, and oversized instructions are WARNINGS.
- `createScannedWorkspaceSkills` implements `WorkspaceSkills` over that scan, so ONE
  parser feeds the Settings panel, the processor, the tools and explicit activations
  and UI status cannot diverge from live behavior. Its lifetime is one request: lazy
  initial scan, `maybeRefresh()` a no-op after, no fs watchers.
- Containment-check and bound every reference, script and asset read, log and return
  null on oversize, and keep disabled skills invisible in list, get, has, search and
  reads. `skill_search` is a deterministic per-line term matcher, no embeddings.
- The `skill` tool's result IS the instruction payload, so
  `SKILL_ACTIVATION_RESULT_TOKEN_BUDGET` is an explicit per-tool override in
  `boundToolOutputForModel`, the tool self-bounds to the same ceiling with an honest
  truncation note, and the generic Mastra `toModelOutput` projection honors the
  override. `skill_read`/`skill_search` self-bound to the native budget with
  line-range and narrower-query hints.
- Compose `SkillsProcessor` into the PER-CALL `inputProcessors` in
  `buildToolLoopOptions`, FIRST so the TokenLimiter counts the injected
  `<available_skills>` block; per-call options REPLACE the Agent-config array. Add
  the skills workflow instruction line only when the `skill` tool survived the gates,
  and exclude provider `'local'` on both sides.
- Build the TRUSTED engine server-side per request over `createSecureSkillsFs`
  (per-call SecureRoot open/close, reads refused outside the candidate containment
  roots) and set it on `runtimeData.workspaceSkills` — agent-only, never serialized,
  a client-supplied value STRIPPED.
- The renderer sends only `skillsPreference` `{masterEnabled, disabledSkillKeys}`,
  strictly parsed (malformed → warn plus fail-safe default) and reduce-only. Keys are
  durable (`deriveSkillPreferenceKey`), the `.brainstrike`/`.claude` tiers of one
  scope share a key on purpose, and the store (only `true` entries) is registered in
  `factory-reset-helpers.ts`.
- User-invocable skills (`user-invocable` ≠ false) are a third slash-entry kind,
  merged after user commands with collision-drop warn-once; execute STAGES a visible
  `:skill[name]` directive into the composer draft, trigger stripped, draft
  preserved, never auto-sent.
- At the request boundary (`skills-activation-context.ts`, between referenced files
  and workspace instructions, skipped on approval and resume legs) each directive
  resolves through the SAME engine into one prepended `system` message carrying
  `formatSkillActivation` output, byte-identical to the tool's payload. Unknown or
  disabled skills get an explicit in-context note; the per-skill, per-message
  (`MAX_ACTIVATED_SKILLS_PER_MESSAGE`) and aggregate caps truncate or omit with
  honest notes; with skills off, directives stay inert text.
- Settings → Skills runs the SAME scan as the engine (`window.skills.scan()`, channel
  `skills:scan`) and shows invalid entries with exact errors, shadowed entries with
  winners, spec warnings and Refresh; a rejected scan renders a distinct error state
  with Retry, never the empty state.
- `SkillsBridge`, `SKILLS_BRIDGE_REQUIRED_METHODS` and `resolveSkillsBridge()` live
  in `@brainstrike/assistant-contract/skills-bridge`, not app-shell, because both
  app-shell and settings-ui consume them and settings-ui cannot import app-shell.

Skills are default-ON with no per-skill trust gate: skill content is
instructions-only, the permission engine's `edit/execute:ask` defaults are the
backstop, and all reads are SecureRoot-contained and bounded. See ADR-0016.
Deferred: web, fs-watch refresh, `SkillSearchProcessor`, a create-skill scaffold,
composer chips for activations. Evidence: `workspace-context/agent-skills.md`.
Guard: `packages/agent/src/__tests__/skill-scan.spec.ts`,
`scanned-workspace-skills.spec.ts`, `skill-tools.spec.ts`,
`mastra-skills.integration.spec.ts`,
`apps/desktop/src/__tests__/assistant-server/request-skills.test.ts`,
`skills-activation-context.test.ts`,
`packages/assistant-contract/src/__tests__/skills-bridge.test.ts`.

---

## EDIT CHECKPOINTS (UNDO OF AGENT FILE EDITS)

The agent host owns edit checkpoints. The first time a run changes a path, Core
captures that path's prior state as a content-addressed StateStore blob and commits a
`workspace.edit.recorded` row with the edit's attribution. Revert restores a run's
paths to those baselines. The run log is the only record: thread deletion collects the
blobs with the thread, and no PGlite table holds edits (migration 147 dropped the old
journal). Desktop-only, capability-gated.

- A baseline larger than `HOST_EDIT_BASELINE_MAX_BYTES`, a symlink or a non-file is
  recorded as `unavailable` with its reason, and that entry renders VISIBLY DISABLED
  with the reason — never a click-time surprise, never silent removal.
- The conversation reads checkpoints as a fold of committed rows
  (`foldHostEditCheckpoints`, adapted by `CommittedHostCheckpoints`). Every revert is
  Core's `checkpoint/revert`, which commits `workspace.edit.reverted` with one outcome
  per entry.
- Core refuses a revert while the thread has an unfinished run, and refuses an entry
  whose workspace folder is no longer connected at the same location. A path whose
  disk state no longer matches the edit's after-state is a `conflict` unless `force`;
  a path already at its baseline is left alone. A rename restores its source before
  removing its destination. A run revert restores each path once.
- The per-turn footer is RUN-SCOPED: rendered once per run, on the run's LAST leg,
  reverting each owned run sequentially, newest first. Why: the default `edit:ask`
  policy splits one run across several live assistant messages.
- Both controls share one UX contract — confirm → restore, on-disk conflict →
  "Revert anyway", idempotent after success — and the footer surfaces a visible
  failure state with retry, never stuck in `reverting`. Pure capability gating: no
  provider on web, never a disabled stub.
- A revert that restored anything commits the run's Task Ledger label: every
  revertible edit reverted → `'failed'`, partial → `'mixed'`, with
  `source:'edit_revert'`. A later explicit user verdict outranks it.

Key files: `packages/agent-host/src/workspace-edits.ts`, `edit-checkpoint-view.ts`,
`apps/desktop/src/renderer/committed-host-checkpoints.ts`,
`edit-checkpoint-context.tsx`, `tool-fallback-row.tsx`, `checkpoint-turn-revert.tsx`,
`packages/assistant-contract/src/edit-checkpoints.ts`.
Evidence (pre-host journal and snapshot undo): `workspace-context/edit-checkpoints.md`.
Guard: `packages/agent-host/__tests__/workspace-edits.integration.test.ts`.

---

## MODEL-FACING WORKSPACE TOOL GUIDANCE

Hosted default instructions are a compact routing layer, not a second copy of every
tool description and schema. Per-tool mechanics live in the canonical description and
Zod registries documented in `docs/agents/assistant-providers.md`, which also owns
the prompt-token boundaries and their measurement. Prompt compaction MUST preserve
these semantics:

- Main vs Focused: `listWorkspaceContext.workspaceRootPath` is the MAIN operating
  root; selected context and the default selection write-back target belong to the
  FOCUSED root. Never relabel or substitute one identity for the other.
- Multi-root qualification: path-bearing read/search/edit/shell calls name the owning
  root. A rootless search means an intentional all-roots search only where its schema
  promises that; it never means "guess Main". Results carry root identity, and
  root-resolution errors include only complete, copyable ids inside their descriptor
  budget, with no leading delimiter when no description fits.
- Tapestry precision: ranges are 1-based and inclusive. Select the exact verified span
  the user named and report the exact range applied; use a whole file only when asked
  or genuinely required.
- Progressive reads: cheapest discovery verb first, then only the needed ranges.
  Continue bounded results with their advertised offset or range, and issue
  independent reads in parallel where safe.
- Create vs edit: `writeWorkspaceFile` stays initially visible so a direct
  create-new-file request never depends on discovering a deferred primitive, and it
  stays edit-risk and approval-gated. A replace against a missing file returns a
  trusted input error pointing at the write tool — never silently reinterpreted as
  creation.
- Command safety: `executeCommand` is unsandboxed. Prefer read-only commands, and run
  destructive ones only on an explicit request for that exact action.
- Web privacy: web search and extraction send queries or URLs to an external service.
  Never include secrets or private workspace content, and never substitute web
  retrieval for local workspace tools.

`workspace-model-projection-helpers.ts` shares only mechanical invariants — record
and integer guards, Unicode-safe clipping, text-envelope construction,
serialized-envelope budget measurement. Domain result types, parsing and coherence
rules, pagination, ranking, producer constants, omission guidance and path policy
stay local to each projection. Search projections emit the producer path VERBATIM
with line breaks escaped and never clip it: an oversized path overflows the
projection budget and its item is omitted with an advancing offset, because a clipped
path is an unusable selector. Malformed or over-budget output fails visibly, and the
shared helpers add no coercion or fallback. Conditional assembly advertises only
tools that survived runtime gates; recover prompt budget by removing duplicated
prose, never by weakening these invariants.

Evidence: `workspace-context/model-facing-guidance.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`.

---

## READ-BEFORE-WRITE STALENESS GUARD (LOST-UPDATE PROTECTION)

The compare layer of core's workspace `requireReadBeforeWrite` contract, adopted
COMPARE-ONLY.

- `packages/agent/src/tools/file-read-state.ts` holds a pure in-memory map of
  `scope|canonicalAbsolutePath → last observed mtimeMs`, scoped by
  `runtimeData.memory.threadId` (sentinel `__no-thread__`), so one thread's
  observations never vouch for another's. It is ephemeral main-process run state, not
  persistence and not a factory-reset surface, bounded by LRU-on-write eviction at
  `FILE_READ_STATE_MAX_ENTRIES`.
- Record content-bearing reads, the assistant's own successful
  `write`/`stringReplace` (post-write stat inside the same lock, so consecutive
  same-thread writes never self-trip), and a rename's destination. `delete` and a
  rename source FORGET their record, so a later re-creation is new rather than
  compared against a ghost. `findWorkspaceSymbol` deliberately does not record:
  snippets are not knowing the file.
- Compare inside the per-file lock's critical section: `write` stats the target before
  mutating, `stringReplace` compares its own fresh under-lock read's mtime, `rename`
  compares the source's lstat. A mismatch returns a typed actionable refusal telling
  the model to re-read and retry.
- Exempt files this scope never observed (the compare-only contract), brand-new files,
  and an observed file that VANISHED from disk — drop the stale record and proceed.
- Run the read tool's read-and-record inside the same per-file lock as the writes, so
  a racing read cannot clobber a fresh own-write observation back to a stale value.
- Record under the realpath'd TARGET: a rename compares a symlink source via the
  target's key and stat, a dangling link has nothing to compare, and a symlink rename
  leaves the target's observation valid with no destination record.

Scoping is compare-only: do not widen to core's stricter "refuse any overwrite
without a prior read" without revisiting the test surface that legitimately writes
unread files. Accepted residuals: coarse-mtime filesystems can miss a sub-granularity
external edit, and a checkpoint revert writes outside these tools, so a thread's next
edit to a reverted file may hit one refusal. Evidence:
`workspace-context/read-before-write.md`.
Guard: `packages/agent/src/__tests__/file-read-state.spec.ts`,
`apps/desktop/src/__tests__/assistant-server/assistant-tools-write-staleness.integration.test.ts`.

---

## WORKSPACE ROOT IDENTITY: MAIN vs FOCUSED

Two DISTINCT root concepts exist in a multi-root workspace; never conflate them.

- **MAIN root** = the assistant's OPERATING root, `activeRootIds[0]` in the
  file-explorer store (insertion-ordered and persisted, so persisting the order
  persists the choice). It drives the hooks `primaryCwd` and the model-facing
  `listWorkspaceContext.workspaceRootPath`. Only `setMainRoot` or disconnecting the
  main root — which promotes `activeRootIds[1]` — changes it, and a re-added removed
  root appends at the END, demoting a former Main visibly and recoverably.
- **FOCUSED root** = SELECTION state (`currentFolderId`). It drives the Terminal
  panel's default cwd, selection scoping and the selection write-back default, and it
  flips on any incidental click — so it must NEVER drive hooks or model cwd. Surface
  it visually, never as the assistant's root.
- `setActiveRoots` is ORDER-PRESERVING, not a blind overwrite: still-reported ids keep
  their relative order, a newly reported id appends at the END, and an id no longer
  granted drops out. Why: boot restore rebuilds `activeRootIds` from a separate
  main-persisted `rootsList` that is plain add-order with no notion of Main, so
  without this every restart would demote the declared Main root.
- The main-owned root registry is the authority and IPC and renderer are projections:
  add, restore and disconnect complete in the registry before renderer state changes,
  and a rejected disconnect leaves renderer state intact. Unavailable or transiently
  unmountable entries stay persisted with `permissionState:'unknown'`, are retried
  later, and are excluded from the mounted capability set and DB live-root
  convergence. The legacy `lastFolderPath` is presentation-only.
- The Terminal's cwd is FOCUSED-by-default, PINNED-when-asked, and the pin is
  SHELL-ONLY: it carries `{ cwd, rootId }`, survives focus changes on purpose, and is
  released by the panel's own control or factory reset. Command sessions always take
  the FOCUSED root, never the pin, so their destructive actions cannot silently
  retarget onto a pinned checkout.
- Forge identity follows MAIN, never FOCUSED. Why: a focused selection flips on
  incidental clicks and would attribute a PR to the wrong repository.
- The per-request `mainRootId`/`mainRootPath` fields are an ORDERING HINT — not a
  security boundary, not the durable thread-binding authority. `workspaceRootPath`
  stays the FOCUSED root.

**Thread and run binding.** Desktop data-stream threads persist their first request's
explicit Main root in `mastra_threads.metadata` as `operatingRootId` plus
display-only name and path; the durable id is the execution authority.

- At first request preparation, resolve the mounted adapter root path to exactly one
  live DB `roots.id`, failing visibly rather than persisting an adapter id or
  guessing. Later global Main/Focused changes never retarget that thread or its
  composer chip. Request preparation reuses the persisted id and emits
  `boundWorkspaceRootId`; approval and resume preparation are pinned by an in-memory
  copy before the metadata-store rerender lands.
- A restored tab selected before its `mastra_threads` row loads keeps the composer
  disabled and fails root resolution visibly; never treat that as missing metadata and
  rebind it to the current Main root.
- Validate the bound id against server-loaded live DB roots before hooks or the initial
  manifest can use another mounted root, then order the bound root first. An omitted
  native workspace-tool `root` resolves to the binding; an explicit selector for
  another mounted root stays an observable cross-root operation; an explicitly blank
  selector is invalid and never broadens a search or falls through to the binding.
- Bound-root resolution requires an authoritative `workspaceRoots` inventory: with DB
  enrichment unavailable the tool fails visibly rather than comparing the durable id
  against a synthesized path-backed root or clearing the binding. A missing, stale or
  disconnected bound id fails visibly as `bound_workspace_root_unavailable` with HTTP
  409 — never a path fallback, never silently adopting the new global Main root.
- The one omission exception is `readWorkspaceContext` with no `filePaths`: its
  renderer-selected paths and Tapestry ranges are relative to the FOCUSED
  `workspaceRootPath`, so that read resolves the focused path against the
  authoritative inventory and fails visibly when the inventory is unavailable.
  Supplying `filePaths` restores the normal rule.
- Disconnect transitions revoke already-enriched in-flight runtime snapshots; a later
  authoritative live-root load clears that revocation after reconciliation.

**Initial workspace-root manifest.** Every fresh hosted-provider turn receives one
`system` message before the model's first action, injected at the shared
`toAiSdkStyleStream` boundary — after Desktop enrichment, before Mastra memory
selects the current turn — so it covers every hosted provider consistently, with
existing leading system context still ahead of it.

- Its bounded JSON block carries only the server-resolved root selector, display name,
  canonical path and Main/Focused roles — never a tree, file list, selection list or
  glob result. It is capped in serialized characters and root count, Main and Focused
  prioritized, the remainder reported as explicit `shown`/`omitted` counts.
- Exact root selectors are never truncated: an oversized selector is omitted and
  counted. Names and paths are clipped, JSON-escaped and described as inert data.
- Desktop with a successful empty DB query emits `state: available, count: 0`; Hosted
  Web or degraded Desktop state emits `state: unavailable` and never invents a
  client- or path-derived selector. The compact built-in local model is excluded, and
  `listWorkspaceContext` remains the detailed refreshable source.

**Server-side reorder.** `enrichRuntimeDataWithWorkspaceRoots` loads live DB roots
(`created_at ASC`), prioritizes an exact `boundWorkspaceRootId`, and otherwise calls
the pure `orderWorkspaceRoots(roots, mainRootId, mainRootPath)`, matching by rootId
first and else by resolved absolute path.

- An unmatched binding stays unmatched so tool execution fails visibly; unmatched or
  absent Main keeps `created_at` order with a debug log. `roots[0]` is therefore
  genuinely the thread-bound/Main root.
- On a DB load or query failure, RuntimeData stays unenriched and workspace-tool
  authorization fails closed; the renderer's FOCUSED `workspaceRootPath` is selection
  state and never becomes a synthesized root.
- A successful zero-root query records an explicit `workspaceRoots: []`, distinct from
  an unresolved inventory, and clears any stale FOCUSED `workspaceRootPath`.
- The desktop HTTP boundary strips any client-supplied `workspaceRoots` before
  enrichment; only the DB result populates the trusted manifest and tool inventory.
  Roots that leave the mounted set are marked `status = 'disconnected'`, so the
  trusted inventory tracks reality rather than serving phantom live roots.

Evidence: `workspace-context/root-identity.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/workspace-roots.test.ts`,
`packages/agent/src/__tests__/workspace-root-manifest.spec.ts`,
`packages/file-explorer/src/actions/__tests__/active-root-actions.test.ts`.

**Background indexing readiness (BST-630, BST-1654).**

- `isAccessLoading`, `rootsReconciliationSettled` and the database and runtime
  dependencies own restoration readiness. Until they settle sync stays `waiting`;
  elapsed time never bypasses them and there is no tree-restoration grace timer.
  `resolveDbRootId` awaits each root's registration before import.
- The indexer scans through the filesystem adapter, not the rendered tree, so tree
  loading and expanded-path restoration neither delay indexing nor cancel a pass.
- Unmount — including the teardown effect re-running on plain `service` identity churn
  — calls `detach()`: abort the renderer loop, drop the progress subscription, leave
  the durable run alone, re-attach on the next `sync()` via
  `selectRecoverableBackgroundBackfill`. A deliberate stop calls `cancel()`, which
  also kills the host run.
- Detaching drops tracking, never cancellation authority: `cancel()` and the disabled
  `sync()` path both enumerate `getBackfillsInFlight()` and cancel every run carrying
  the `background-indexing-backfill:` request-id prefix, leave unclaimed runs alone,
  and reject an undeliverable stop rather than reporting success. Both halves are
  load-bearing — trade one for the other and the user either loses indexing on
  navigation or cannot stop it.
- Refresh the active collection's statistics once per successful root import, after
  chunking and assignment batches finish and before embedding completion.

Evidence: `workspace-context/background-indexing-readiness.md`.
Guard: `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-provider.test.tsx`,
`workspace-collection-sync-service.test.ts`.

**Worktree roots and the Mode chip (BST-1390, BST-1392).**

- A root mounted for a managed worktree carries `roots.kind = 'worktree'`, set at
  INSERT by `reconcileRoots` from the ledger-only `listManagedPaths()` set — a
  boot-critical read that never builds git inventory or resolves workspace-root joins.
  Until the first successful ledger read, update existing rows but DEFER new inserts,
  so a transient bridge failure cannot durably misclassify a worktree. `kind` is never
  modified on an existing row, and the DB column carries a real CHECK constraint.
- Background indexing defaults OFF for `kind='worktree'`, surfaced as `Not indexed`
  with the duplicate-corpus reason and a per-root opt-in keyed by the durable DB root
  id. Opting one root in never changes another or suppresses eligible non-worktree
  roots, and if every mounted root is excluded sync stays visibly `waiting` with the
  same explanation.
- Defer a mounted root with a durable id but no published kind from the current sync
  pass; publishing its reactive kind map restarts the pass, so a mid-session Add
  Folder cannot race the exclusion.
- Mode chip (Local / Worktree): Worktree means an isolated linked worktree BrainStrike
  created, recorded in `brainstrike_worktrees`, mounted through the managed-worktree
  grant and bound as the thread's PRIMARY through the same `operatingRoot*` triple —
  which is what makes the server's `boundWorkspaceRootId`-first ordering resolve
  hooks, tools and the terminal into the worktree with no server change. "Cloud" is
  deliberately omitted, not stubbed.
- A non-repository primary root gets a DISABLED chip stating "Not a git repository",
  never an absent one. The chip's worktree list comes from the `window.worktrees`
  bridge's `list()` (ledger plus a live `git worktree list` merge), refreshed on mount
  and after every create/select/archive mutation, independently of the Branch chip.
- The picker lists EVERY worktree the ledger reports, including other tools', labelled
  by tool, each usable or disabled with its reason and, where remediable, a "Grant
  access…" button. A creation failure renders IN the create sheet and leaves the
  thread on Local rather than partially switching it.
- Write both dialogs inside `ModeChip`'s own JSX rather than hoisting them, so their
  `<Dialog>` nesting depth stays 1 and their panel paints at `z-[51]`.

Evidence: `workspace-context/worktree-roots.md`.
Guard: `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`,
`packages/assistant-ui/src/__tests__/mode-chip.test.tsx`,
`apps/desktop/e2e/worktree-mode.desktop.test.ts`.

**Picker-less mounts and OS folder-open gestures (BST-1393, BST-1395).**

- `fs:addRootByPath` is the second and last sanctioned picker-less mount. It accepts a
  path authorized by EITHER the recent-roots ledger OR the managed-worktree
  authorizer: a live `brainstrike_worktrees` row whose realpath is reachable per
  adoption's `assertReachable` rule — under the realpath'd managed directory, or
  inside a granted workspace root per a FORCED-FRESH inventory's containment. One
  shared `isReachableCheckout` predicate backs both rules so they cannot drift.
- Force a fresh inventory rather than the cached snapshot: a `roots` write never
  dirties the cache, so a cached read could honor a just-closed root.
- An unavailable inventory refuses only the in-root arm, at WARN; the
  managed-directory arm is inventory-free. An outside-roots row stays refused, and a
  ledger row alone is never a mount grant. Check the ledger FIRST, so a broken
  authorizer cannot take the recents path down with it.
- Never write managed worktrees into `recentRootsList`, at grant time or on relaunch
  restore: that list is the user's folders, not the app's scratch directories.
- Five gestures ask the app to connect a folder — File ▸ Open Folder…, File ▸ Open
  Recent, argv/`second-instance`, macOS `open-file`, and a Finder folder dropped on
  the workspace bar. All converge on ONE renderer seam, `useConnectFolder`, calling
  the existing picker-less `fs:addRootByPath`. Add no third authorization door.
- A path from any gesture is a REQUEST, never a grant: `open-file` and argv are
  attacker-influencable, so `connectPath` uses the same picker-less path Add Recent
  uses, renders the same "never granted, use Add folder…" remedy on refusal, and
  resolves to the mounted handle on success or `null` on every already-toasted failure.
- Main→renderer traffic uses the dedicated `window.workspace` bridge, not a fourth
  `window.platform` member whose exact-set pin is duck-typed elsewhere.
  `workspace-connect-bridge.ts` is canonical for the required-method set, the
  five-member `WorkspaceOpenOrigin` union (`argv` · `drop` · `menu-recent` ·
  `open-file` · `second-instance`, compile-time pinned on both sides), and the two
  exact refusal strings the renderer's remedy matcher shares with main.
- Strip the `ipcRenderer.invoke` error envelope before matching a refusal, and match
  ANY `*Error:` name rather than the literal `Error:`. Why: main throws an
  `AccessError` whose class name survives IPC serialization, and a literal-only
  stripper silently degraded the remedy to a generic toast.
- File ▸ Open Folder… opens no dialog in main: the menu item pushes a picker request
  to the focused window and the renderer runs the SAME `addRootDirectory()` the Folder
  chip runs, keeping grant recording, recents refresh and the reconciliation nudge on
  one path. Menu callbacks forward Electron's click-handler window, with
  `getFocusedWindow()` only as fallback, because it is null whenever the app is not
  OS-active.
- File ▸ Open Recent projects main's own ledger, capped at `FILE_MENU_RECENT_LIMIT`,
  newest first, DISABLED rather than hidden when empty, rebuilt on a coalesced 250 ms
  schedule whenever the root-grant subscriber fires. There is no "Clear Menu" row:
  clearing only `app.clearRecentDocuments()` changes nothing visible, and clearing the
  ledger from a menu item would silently revoke picker-less grants.
- A recent-menu click sends `workspace:open-path` directly to the focused window;
  launch-scoped producers go through `createWorkspaceOpenQueue`. `open-file` is
  registered at MODULE scope (macOS fires it before `whenReady`) and stays registered
  in E2E mode; launch argv is enqueued once inside `whenReady`; `second-instance` is
  registered only outside E2E mode.
- `resolveFolderCandidatesFromArgv` skips the unpackaged app path by IDENTITY
  (`app.getAppPath()` or the running bundle's entry path), never by argv position.
  Why: Chromium regroups `second-instance` argv as
  `[program, ...switches, ...positionals]`, so a fixed `slice(2)` mis-parsed the
  app-path positional into a folder candidate. Only the FIRST matching positional is
  skipped — a later duplicate is an explicit `electron . .` request — and an empty app
  path THROWS. Packaged parsing consults neither.
- Filter candidates before the IPC channel: loudly skip non-directories and
  unstat-able paths, and cap at `MAX_PENDING_OPEN_REQUESTS` (oldest dropped with a
  warn) before the sync stat loop, so a runaway `second-instance` cannot stall main.
- Gate queue delivery on a TWO-condition per-window handshake: `loadFinished` tracks
  the symmetric `did-start-loading`/`did-stop-loading` pair — not main-frame-only
  `did-finish-load`, which strands the queue after a subframe-only load — and
  `rendererReady` is the renderer's own ready ack, pinged in the SAME effect that
  subscribes the listener, because a loaded document is not a mounted listener and
  Electron never replays an unheard `send`. Reset `rendererReady` only on a real
  main-frame document replacement.
- Register the ready channel ONCE at module scope and route it per window via a
  `webContents.id`-keyed callback map, capturing the id AT registration, because the
  `win.webContents` getter itself throws once `closed` has fired. Detach the queue on
  `closed` explicitly: `isDestroyed()` still reports `false` while a window is dying.
- Delivery is not authorization: narrow every delivered payload (malformed dropped
  with a log, never coerced) and pass the seam's `fs:addRootByPath` gates. Nothing in
  this machinery records a recent root.

Evidence: `workspace-context/folder-open-gestures.md`.
Guard: `apps/desktop/src/__tests__/workspace-open-queue.test.ts`,
`workspace-open-ready-ipc.test.ts`, `main/workspace-open-lifecycle.test.ts`,
`folder-argv.test.ts`, `application-file-menu.test.ts`,
`apps/desktop/e2e/add-root-ui.smoke.desktop.test.ts`.

**Surfaced UI.** The composer workspace bar is always visible; every other surface
here is forest-mode/multi-root only, so a single root shows no extra chrome. Root
section headers carry the "Main" badge (exactly one; the badge MOVES when main
changes — sections never reorder), a persistent focused affordance (app state, not
`:focus-visible`) and a full-path tooltip. The status-bar item lists every mounted
root with a per-row "Set as main".

**Composer workspace bar.**

- The bar mounts as a SIBLING of ThreadContextMeter — never nested there — and is
  always visible, single root included, because its job is ORIENTATION, not
  disambiguation. Zero roots render the "Choose a folder" CTA.
- Folder chip: this thread's PRIMARY (persisted `operatingRootId`, else the current
  MAIN root) plus `metadata.secondaryRootIds` as a `+N` badge. The primary's `rootId`
  is ALWAYS a durable `roots.id`; with no persisted binding the MAIN root's row
  resolves BY PATH, and an unresolvable path leaves the primary undefined rather than
  inventing one.
- "Make primary" re-binds the THREAD through the same three `operatingRoot*` keys
  `persistThreadRootBinding` writes, in ONE metadata write with the secondary set; it
  never calls `setMainRoot`. "Remove from thread" only edits `secondaryRootIds` and
  never disconnects the folder from the workspace.
- While checkout mode is Worktree, making a secondary primary includes the Local
  transition in that SAME write, so operating root and checkout record never disagree:
  the former worktree primary leaves the thread with an explicit success toast, other
  secondaries stay attached, and a failed write retains the prior folder set and
  checkout record. The secondary named by `checkoutLocalRootId` keeps its Remove
  action visibly disabled, keyboard-focusable, with its reason as an accessible
  description.
- "Add folder…" adds the folder globally AND records it as a thread secondary,
  awaiting the roots-reconciliation "root registered" notification instead of polling
  the database, bounded by `ROOT_ROW_WAIT_TIMEOUT_MS`; exhaustion logs and toasts
  "Folder added, but not attached to this thread". The seam is EPOCH-based, not a
  one-shot flag, because re-adding a removed folder is a genuine second registration
  of the same path.
- `use-thread-checkout.ts` is the ONLY writer of `metadata.checkout*`. Selecting a
  worktree first resolves its mounted path to a durable live `roots.id`, then persists
  the `checkout*` fields, full `operatingRoot*` triple and secondary demotion in ONE
  metadata write through the bar's serialized folder-write queue;
  `checkoutLocalRootId` durably records the Local `roots.id` at entry, and a
  reconciliation failure rejects before enqueueing.
- Hand-off promotes the tracked Local root when it has a complete roots row; a
  disconnected tracked root is logged and refused, while legacy partial state with no
  tracked Local root clears checkout mode, warns that the folder did not follow, and
  keeps its current primary. Every checkout-mode transition atomically strips
  `checkoutBranch`; the Local transition also removes both worktree keys and
  `checkoutLocalRootId`.
- The Worktree Map tab is capability-gated like Changes/Canvas/Terminal, never an
  `isElectron()` check. Its handlers publish a ONE-SHOT checkout intent the consumer
  applies to the selected thread exactly once, calling the SAME callbacks the Mode
  chip uses: the intent store is a cross-component REQUEST queue, never a second write
  path, and a failed apply is logged and toasted without retry.
- Recents come from main's ledger minus folders already mounted. Every flow that may
  write the ledger increments `recentRootsRevision` and the bar reloads from that
  canonical signal — an honest superset — so new grant or restore callers need no
  bar-specific wiring. Recents loads use a monotonic request generation, so an older
  overlapping response cannot replace a newer snapshot.
- The bar therefore cannot mount an arbitrary path: a stray or stale path string is
  rejected, and the ledger is one input to the main-owned mount decision, never a
  replacement for it. Reject renderer mutation of `rootsList`, `recentRootsList`,
  their quarantine records, `notesVaultRoots` and `lastFolderPath` through the storage
  channels; desktop E2E uses a test-mode-only seed channel production never registers.
- Key ledger paths with a stripped trailing separator, so `/ws/alpha/` and `/ws/alpha`
  are one slot. Quarantine a CORRUPT ledger to `recentRootsList.corrupt`, log at ERROR
  and reset it; until the next grant re-populates it, `addRootByPath` rejects with the
  normal "never granted" remedy. `RECENT_ROOTS_LIMIT` is storage hygiene, far above
  realistic mount counts so connected roots cannot evict disconnected grants.
  Desktop-only: web has no ledger and no Add-recent affordance.
- Finder drop: `extractDroppedFolderPaths` turns `DataTransferItem`s into absolute
  paths SYNCHRONOUSLY, inside the drop tick, because an item goes invalid the instant
  the event settles. Tell files and folders apart by ASKING THE DOM
  (`entry.isDirectory`), never by `size`/`type` and never by forwarding blind to
  `connectPath`, whose grants-flavored refusal would misdescribe the problem.
- Count every drop non-outcome in three SEPARATE buckets — skipped files, unreadable
  items, unresolved folders — so the notice never names the wrong noun, and dedupe in
  drop order.
- `WorkspaceBarDropZone` wraps the chips ONLY when a drop handler is supplied — no
  wrapper, no ring, no listeners on web. Its `'Files'` MIME-type gate, checked BEFORE
  `preventDefault()`, is byte-identical to the notes-vault panel's copy and is what
  keeps an internal drag from being consumed: harden one copy, check the other. The
  drag-leave guard reads `event.relatedTarget`, because a dragleave bubbling off any
  chip would otherwise flicker the ring.
- Connect multiple dropped folders ONE AT A TIME: the mount call shares a loading flag
  and a "most recently mounted becomes focused" outcome, so concurrent firing makes
  order non-deterministic. Chain the SAME thread-attachment step Add folder…/Add
  recent… run; a refused connect records nothing and fires no second notice; a fully
  clean drop toasts NOTHING — the chip appearing IS the feedback.
- Reveal never hardcodes an OS name: the prop pairs `{ label, onReveal }` so a handler
  without a label is a type error, fed the platform-aware `revealLabel()`.
- Branch chip: `window.git.status` supplies branch/detached, ahead/behind and
  dirty-dot state, with no polling. The dot refetches on BOTH live-refresh signals —
  every accepted `changes:invalidated` metadata push AND the primary root's git-scope
  nonce, which is what carries WORKING-TREE edits, since metadata pushes report
  topology only.
- The menu reuses the Git workbench's `buildBranchSwitchModel`, and the shared switch
  gate derives dirty state only from tracked porcelain entries, so an untracked-only
  checkout stays switchable while the dot still reflects all entries. A branch held by
  another worktree shows its owner and an explicit disabled reason, and a disabled
  dirty row offers a new-worktree switch only when that callback is supplied.
- Switching and creation call the existing bridge paths with no client-side status
  pre-check — the bridge result is the source of truth, and a failure is logged and
  surfaced as a destructive toast. Offer Fetch only for a discovered default remote,
  naming it explicitly. After a successful mutation, refresh the git inventory and
  advance the hook's own reload nonce.
- The switcher's own load is keyed on the invalidation and reload nonces, NOT the
  root's git-scope nonce, so an external edit to a tracked file can leave its
  tracked-dirty read stale until the next metadata push or successful mutation. It
  fires its own status read concurrently with the bar's dot, and on a non-repository
  primary root stops after that probe with no repository read and no warning.
- There is no empty-list fallback: a failed menu read is logged and leaves the chip
  non-interactive. The chip is desktop-only, absent for a non-repository root or a
  failed checkout-status read — logged, NEVER rendered as "clean" — and withheld
  whenever the primary root is absent.
- Both live-refresh signals need the main-process git inventory to have ARMED a
  watcher for that repository, which only happens inside an inventory build, so root
  registration nudges discovery with `changes.inventory({ maxAgeMs: 0 })` once; the
  forced option is what beats the TTL cache and in-flight coalescing. See "Discovery
  refresh on root registration" in `docs/agents/changeset-diff.md` § REFRESH SEAMS.

Evidence: `workspace-context/workspace-bar.md`.
Guard: `packages/assistant-ui/src/__tests__/workspace-bar.test.tsx`,
`packages/app-shell/src/__tests__/use-workspace-bar.test.tsx`,
`use-thread-checkout-status.test.ts`,
`apps/desktop/e2e/workspace-bar.desktop.test.ts`,
`apps/web/e2e/workspace-bar.test.ts`.

**Root-header context menu (BST-1393).**

- `packages/context-actions/src/types.ts` carries a `workspace-root` ContextTarget
  kind (`displayName` · `isMain` · `path | null` · `rootId`); `workspaceRootToTarget`
  normalizes a web FSA handle's name-as-path to `null`, so path-shaped actions hide by
  DATA rather than by platform.
- Both the forest sidebar's root sections and the SINGLE-ROOT layout's header row wrap
  ONLY their header in `ActionContextMenu` — never the tree pane, which owns its own —
  so the two menus stay siblings rather than nesting, and both share the
  claim/reset/local-actions/focus-restoration protocol through
  `use-root-section-context-menu.ts` rather than two independent copies.
- Six items, three owners. GLOBAL registry: `workspace-root.copy-path`,
  `workspace-root.reveal`. SURFACE-LOCAL in `file-explorer-ui`:
  `workspace-root.set-as-main` and a staged `workspace-root.disconnect`, present only
  when the surface actually has a way to disconnect. INJECTED by app-shell through
  `FileExplorerPanel`'s `rootActions` prop (`workspace-root-context-actions.tsx`):
  `workspace-root.open-in-terminal` — a mounted root IS its own cwd — and
  `workspace-root.new-thread-here`.
- Set as Main returns an `ActionOutcome`: check `activeRootIds.includes(rootId)` first
  and report `{ ok: false }`, because `setMainRoot` warn-and-no-ops for an unrecognized
  legacy path-identity root and the click would otherwise do nothing.
- This surface says "Set as Main" and changes the workspace-wide MAIN root; the
  workspace bar's "Make primary" is a DIFFERENT operation with a different writer. Do
  not merge the two vocabularies.
- "New thread here" goes through `useCreateThreadInFolder`, the threads panel's own
  folder-bound creation extracted so both surfaces keep ONE writer of the
  `operatingRoot*` triple: one `createThread`, then ONE metadata write.
- `Disconnect…` stages its dialog from inside `ActionContextMenu`'s
  `onCloseAutoFocus`, which skips its own focus restoration while the dialog is open.
  Why: Radix's exit animation means the menu's real unmount fires AFTER the dialog has
  mounted and autofocused. Escape closes the dialog with the root still connected.

Evidence: `workspace-context/root-header-context-menu.md`.
Guard: `packages/file-explorer-ui/src/components/__tests__/root-section-header.test.tsx`,
`packages/file-explorer-ui/src/__tests__/file-explorer-sidebar.test.tsx`.

---

## DIRECTORY HANDLE `rootId` PROPAGATION (REBUILT CHILD HANDLES)

Distinct from Main/Focused: the durable `RootId` UUID stamped on a `DirectoryHandle`
when a folder becomes a registered root. It self-identifies the handle for capability
and mount resolution and gives collision-proof folder-state keys — two same-named web
roots share a `path` but never a `rootId`.

- The invariant: every function that REBUILDS a child `DirectoryHandle` during
  recursive traversal, rather than reusing the handle the adapter returned, carries
  `rootId` forward with parent-anchor fallback (`entryHandle?.rootId ??
  parent.rootId`, the key omitted entirely when undefined). A self-identifying child —
  a nested registered root — wins over the parent anchor.
- Why a fallback and not forwarding alone: on web, adapter child handles are raw
  FileSystemAccess handles with no `rootId`, so forwarding-only logic silently drops
  identity at every depth below the root. `platform` uses the same shape at each site.
- Check this list before adding a rebuild site — the class has recurred four times,
  and two of the six sites were missed because they ship in no app today yet are
  public package exports:
  1. `packages/file-explorer/src/read-full-file-tree.ts` — `createChildDirectoryHandle`
  2. `packages/file-explorer-ui/src/utils/parallel-directory-walker.ts` — `buildChildHandle`
  3. `packages/app-shell/src/background-indexing/workspace-collection-sync-scan.ts` — `toDirectoryHandle`
  4. `packages/file-explorer-ui/src/utils/lazy-tree-loader.ts` — the
     `fileNodeToDirectoryHandle(parentNode, options.parentRootId)` calls in
     `loadDirectoryChildren` / `loadDirectoryChildrenStreaming`
  5. `packages/file-explorer-hooks/src/use-file-tree.ts` — the directory-handle literal
     in `processSingleEntry`
  6. `packages/file-explorer-ui/src/utils/process-directory-entry.ts` — `processDirectoryEntry`
- `WorkspaceRootMountTable.resolveForRead` short-circuits to its own
  `this.mounted.get(rootId)` before consulting path containment, so with nested mounted
  roots a read whose `rootId` was inherited from an outer traversal anchor resolves
  against the OUTER mount. That is intended: reads made during a traversal started from
  root R are authorized and attributed under R's capability, and a self-identifying
  nested root still wins.
- Do not conflate `DirectoryHandle.rootId` with `IFileNode.rootFolderId` — the latter
  is a folder-state bookkeeping key defaulting to `handle.path`. Threading one where
  the other belongs re-introduces this bug class under another name.

Evidence: `workspace-context/directory-handle-rootid.md`.
Guard: `packages/file-explorer-hooks/src/__tests__/use-file-tree-root-id-propagation.test.ts`,
`apps/desktop/src/__tests__/ipc-domains/workspace-root-registry.test.ts`.

---

### Persona Settings host checks (BST-1727)

The canonical [persona Settings host-check contract](assistant-subagents.md#persona-settings-host-checks-bst-1727) covers validated scan results, model/tool availability, and request-dependent scope.

### Persona edits and admitted child decisions (BST-1727)

- A user persona scan resolves the profile for a FRESH delegation. Once a child is
  admitted, its effective tool scope, instructions, mode, model pin and clamped step
  budget are stored with that delegated conversation.
- Editing, disabling or removing the file affects fresh root turns only: pending child
  approvals and questions resume with their admitted configuration, including after
  host reload, while current host permissions and available model credentials still
  apply.
- Invalid stored identity or configuration fails visibly rather than selecting a
  replacement profile. Resolve cross-provider credentials from the host on resume,
  never into the profile snapshot, and add no new persona store or reset registration.

Implementation and production evidence live in
`docs/agents/assistant-subagents.md`'s admitted configuration section. Evidence:
`workspace-context/persona-admitted-children.md`.

### Delegated workspace checkpoint ownership (BST-1726)

- The child input processor awaits its existing host admission, including a turn-start
  shadow snapshot before first execution. Resume and recovery retain that baseline, and
  recovery before execution finishes any roots whose capture was interrupted. A legacy
  child with a run but no baseline remains unrestorable, capture failure records the
  existing failed-capture sentinel, and no new content journal or persistence store is
  introduced.
- The child header identifies the shared workspace and the per-path file-write
  serialization mode; no isolated worktree or automatic merge is implied. Revert uses
  the ordinary conflict-checked IPC operation, survives reopening and reload, and
  restores only the selected journaled paths.
- Child file-mutation callbacks retain Mastra's per-execution `abortSignal` as well as
  the host-leg signal and check both immediately before write/replace/delete/rename,
  after the canonical path lock and before-state read. Stopping one child cannot start
  its queued mutation when the lock is released, and an operation already started still
  settles its checkpoint and index attribution: Stop does not roll back completed edits.
- A child's explicit bound root wins over the currently focused folder, including on
  non-Git workspaces. Disconnecting that root is a visible error; neither a new folder
  focus nor unavailable worktree capability authorizes switching roots, and a
  disconnected bound root displays an explicit unavailable-folder label rather than an
  opaque id or a replacement workspace.
- The native executor passes a durable execution thread separately from the read-state
  scope, and a DB-less scope sentinel never becomes checkpoint ownership. Tool input
  cannot choose that identity: strict native schemas reject extra identity fields and
  the common execution reader reads only the host-owned context argument. Already
  stopped native mutations reject before acquiring a path lock, and the post-lock check
  remains necessary when cancellation arrives while waiting.
- Admission does not swallow ledger or database failures: a child must not begin work
  after its baseline ownership could not be established. Snapshot Git failure records a
  failed-capture sentinel.

Evidence: `workspace-context/delegated-checkpoint-ownership.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/assistant-tools-write-staleness.integration.test.ts`,
`delegated-workspace-snapshot.integration.test.ts`,
`apps/desktop/e2e/delegated-worker-write.desktop.test.ts`.

### Managed opaque workspace effects (BST-1726)

- Finite native shell and skill processes acquire an EXCLUSIVE lease on their canonical
  declared workspace root until actual process settlement. Queueing and execution share
  the existing call deadline; an expired waiter never spawns.
- Native file mutations acquire a SHARED workspace lease around their existing ordered
  per-file locks, covering staleness, capture, write, checkpoint and index settlement.
  Overlapping parent/child root paths conflict; disjoint roots and disjoint file
  mutations without an opaque owner retain concurrency.
- Queued cancellation refuses execution before any effect. Skill runtime resolution plus
  lease wait shares its original timeout budget, and expiry names both runtime
  preparation and workspace ownership. Admission expiry and cancellation produce trusted
  model-visible no-execution errors; a session conflict preserves the owning session ID
  and the process-exit requirement through the ordinary tool guard.
- A long-lived DELEGATED command session retains its exclusive lease until PTY exit. A
  conflicting managed edit or process fails visibly with the session ID and the
  requirement to wait for process exit — never queued indefinitely, never silently
  applied later. Selected child Stop joins the sessions owned by host-observed native
  child identities before acknowledging completion, through the existing process manager
  rather than a parallel registry.
- Lease release follows actual exit: a failed stop cannot release uncertain work, and a
  disposal timeout retains the exit observer even after inventory removal, so a later
  actual exit releases ownership without exposing live work. The conflict message names
  no control that has already retired.
- Ordinary root and user command sessions keep their existing dev-server/edit flow; this
  lease does not serialize arbitrary user-owned background servers. Shell cwd checks
  remain the existing containment rule, not a sandbox: command bodies are unrestricted
  after permission. Remote MCP servers own their own filesystem scope and cancellation
  semantics, and arbitrary tool input or metadata never establishes client-side
  workspace confinement.
- Native delegated thread IDs may exceed a filesystem or ref component length at three
  levels of recursion. Snapshot ownership retains the exact native ID in the existing
  ledger and commit metadata, and the Git lineage key is bounded as documented in
  `docs/agents/changeset-diff.md`. Never increase root directory validation limits or
  truncate native identity to make a recursive child snapshot fit.

Evidence: `workspace-context/managed-opaque-leases.md`.
