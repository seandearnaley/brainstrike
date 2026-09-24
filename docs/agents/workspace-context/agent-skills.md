# Agent Skills — evidence

Supports `docs/agents/workspace-context.md` §
"AGENT SKILLS".
Read before changing skill discovery, the scan engine, the skill tools, activation, or the skills preference/UI surfaces.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

Corrections verified against the code on 2026-09-21, after this record was
written: `mergeSkillToolsIntoLocalTools` lives in
`packages/agent/src/mastra/runtime-assembly/tool-pipeline.ts`, not
`agent-runtime.ts`; and `ipc-skills{,-handlers}.ts` sit at `apps/desktop/src/`,
not under `ipc-domains/`. The pipeline ruling itself still holds: `new Agent`
is constructed with no `skills:` option.

## Record

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

