# Prompt workbench — evidence

Supports `docs/agents/workspace-context.md` §
"PROMPT WORKBENCH".
Read before changing the prompt library's persistence, recall, agent actions, or composition seams.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

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

