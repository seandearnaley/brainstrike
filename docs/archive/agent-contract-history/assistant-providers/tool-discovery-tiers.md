# Tool discovery tiers and adapters — evidence

Supports `docs/agents/assistant-providers.md` § "Tool discovery contract (LIVE for hosted Mastra catalog search)". The critical/deferred partition, eligibility, and per-route adapter resolution.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5187-5271); append rather than
rewrite.

---

`packages/assistant-contract/src/tool-discovery.ts` is the authoritative
adapter and loading-tier contract. `createMastraAgentRuntime` now selects
`mastra-catalog-search` explicitly for hosted routes, constructs the Agent from
the post-gate critical/custom surface, and gives only the post-gate deferred
surface to `BrainstrikeToolSearchProcessor` (the fail-loud wrapper around
Mastra 1.51 `ToolSearchProcessor`). Built-in/local runtime behavior is unchanged;
provider-native tool-search adapters remain out of scope.

The canonical native metadata has one exact eight-tool `critical` set:
`askUser`, `executeCommand`, `globWorkspace`, `grepSearch`,
`readWorkspaceFile`, `stringReplaceWorkspaceFile`, `submitPlan`, and
`writeWorkspaceFile`. These are the universal exact-read/search/edit/create/
execute/suspend primitives that remain model-visible after discovery goes
live. Keeping one approval-gated create primitive critical is deliberate:
smaller hosted models otherwise cannot create a new file unless they first
infer that they must search for the deferred write tool. The search/load
control is owned by the selected discovery adapter and must be exposed beside
this set; it is not a second Brainstrike native-tool id. Every other native tool is `deferred` and
belongs to exactly one concise namespace in
`NATIVE_TOOL_DISCOVERY_NAMESPACES`: artifacts, context, embeddings, semantics,
sessions, skills, web, or specialist workspace operations. Namespace parity tests prove
that the critical plus deferred partitions cover every canonical native id
exactly once and that no namespace exceeds nine functions.

Loading tier is not authorization. User-enabled means only eligible for
discovery. `resolveToolDiscoveryPhaseAccess` keeps disabled, permission-denied,
and host-unavailable tools out of search, load, and active phases. An `ask`
permission remains searchable/loadable, but the existing downstream permission
gate must still suspend before execution. A loaded bit is required before an
eligible deferred tool becomes active. Runtime partitioning happens only after
guards, hooks, plan mode, permission, approval-storage, provider web-search,
artifact settlement, and model-output projection; it cannot restore a tool any
earlier stage omitted. Unknown caller-supplied local tools remain eager because
Brainstrike has no authoritative loading metadata for them. Existing
provider-defined web search remains eager because its provider-owned id/type
pair is not a normal function definition that catalog search may rename.
Mastra's canonical `skill`, `skill_read`, and `skill_search` controls also stay
eager: `SkillsProcessor` tells the model to call them directly, so deferring
them would make Mastra's own injected instructions reference unavailable tools.
The eligible `readToolOutputArtifact` recovery control stays eager for the same
reason: settlement emits directly callable continuation actions. This adds no
alias and does not bypass eligibility or permission gates.

`LlmModelDefinition.nativeToolSearch` records provider-native support on the
exact model route:

- Direct OpenAI GPT-5.4 and newer routes declare `openai`; older GPT-5.x routes
  do not. OpenRouter aliases do not inherit the capability because the gateway
  route is a different adapter.
- Current supported direct Anthropic models declare `anthropic`.
- Other declared hosted/gateway LLMs resolve to Mastra catalog search.
- The built-in browser-local model resolves explicitly to `eager-core-only`;
  this contract does not alter its current runtime. Dynamically discovered
  Ollama/LM Studio model ids resolve `unsupported` until their authoritative
  catalog exposes a tool-search capability signal.
- Unknown static model ids and non-LLM providers resolve `unsupported` for
  automatic or provider-native selection. An explicitly requested
  `mastra-catalog-search` adapter is runtime-based: a hosted LLM supplied through
  the supported model-override seam remains valid even when its model id is not
  in the static catalog. Browser-local and non-LLM providers remain unsupported.

`resolveToolDiscoveryAdapter` never substitutes another strategy when a caller
requests an adapter the exact route does not support. The unsupported result
retains a typed reason, keeping an adapter mismatch distinct from a catalog miss,
permission denial, and host unavailability. OpenAI's native `tool_search` is
model-gated, not inferred from `provider === "openai"`. Anthropic native search
likewise preserves provider search/tool-reference history. Live Mastra catalog
search uses `storage: 'context'` and `search: { autoLoad: false, topK: 3 }` —
Mastra's manual-loading mode (BST-1667). `search_tools` is discovery only: it
returns at most three ranked matches and loads nothing. `load_tool` is Mastra's
canonical exact-name selection (`toolName` or `toolNames[]`, "Did you mean"
suggestions on a miss, the same SDK search filter and context-store
activation) and loads exactly the named tools. Every discovery step offers, in
this key order: `search_tools`, `load_tool`, the loaded deferred tools, then
`list_available_tools`. Model-facing flow: exact name known (instructions,
catalog, skill activation) → `load_tool` → call; capability only →
`search_tools` → `load_tool` → call. The trade-off is deliberate and stated
honestly: fuzzy discovery now costs one extra model step versus the retired
auto-load, while an exact load costs the same step it always did and loads one
tool. Do not re-enable `search.autoLoad: true`: per Mastra's own option docs
that mode withholds `load_tool`, and the BST-1628 workaround — a pnpm patch on
`@mastra/core@1.59.0` splicing exact-name selection into `search_tools`' BM25
path — was a misuse of the search control, not a missing upstream feature.
That patch and its `patchedDependencies` entry are deleted; the repo carries
zero pnpm patches again.
