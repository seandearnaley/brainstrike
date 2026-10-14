# Discovery "next turn" wording — evidence

Supports `docs/agents/assistant-providers.md` § "Tool discovery contract (LIVE for hosted Mastra catalog search)". The live failure behind the wording rule, the batching exemption, and the reserved meta-tool ids.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5334-5422); append rather than
rewrite.

---

**"NEXT TURN" MEANS THE NEXT MODEL STEP OF THE SAME RESPONSE — say so
explicitly.** Mastra's loading copy says a loaded tool is "available on your
next turn" (under the retired auto-load it was `search_tools`' system line,
description, and result; under manual loading it is `load_tool`'s success
result). In chat vocabulary a turn is a user message. The 2026-09-02 live
Linear write proof failed on exactly that reading: `search_tools` (then
auto-loading) loaded
`linear.save_issue`, the loaded definition was in the very next step
(`mastra_tool_discovery_step` reported it), and the model still ended its
reply with "I'll create the Linear issue once the ticket integration finishes
loading" — `finishReason: stop`, no `tools/call` ever sent, so the owner saw a
chat that "stopped after the tool call" with no error anywhere. No runtime
layer was involved. Every Brainstrike-owned surface therefore says "callable
on your next step in this same response" and forbids ending the reply to
wait: the instructions' discovery line pins the meaning of "next turn", the
`search_tools` result (`describeSearchMatches`, ranked list untouched) says
matches are not loaded yet and to call `load_tool` with the exact name, the
skill execution guidance says the same, and `wrapLoadTool` rewrites Mastra's
`load_tool` success sentence (`describeLoadResult`) while leaving its failure
copy — not found, "Did you mean" — verbatim, since there is nothing to call.
Mastra's injected system line is the one surface Brainstrike does not own; in
manual mode it says only that tools must be loaded before use, and the
instructions' definition is what neutralizes any "next turn" reading. Pinned by
`default-instructions.spec.ts`, `tool-search-runtime.spec.ts`, and
`skill-tools.spec.ts`.

**THE BATCHING EXEMPTION LIVES ON THE BATCHING LINE — do not relitigate.** A
loaded tool is callable only on the FOLLOWING model step, so batching `search_tools`
or `load_tool` with slow calls strands the discovery for their whole duration: an observed run
issued it alongside two delegations that took ~15 minutes each, then spent three
`search_tools` calls locating one tool the user had named explicitly. The
exemption is therefore carried by `buildParallelCallInstruction`, NOT only by
the discovery line ~15 instructions away — "Batch independent reads, searches,
or commands into one turn" is the plausible proximate cause, since a model
scanning for permission to batch reads "searches" as covering `search_tools`,
and a caveat it has to go looking for is one it will not apply. It is
CONDITIONAL on discovery being installed, so a run without it is never told
about a tool it does not have. Stated once: repeating it on the discovery line
spends prompt budget saying the same thing.

Making a loaded tool callable on the step after `load_tool` is Mastra's tool-search
contract, not ours; the ordering advice is the half Brainstrike owns. The live matrix passes that processor through Mastra
`runEvals.targetOptions`: Brainstrike owns input processors at the per-call
stream seam, so targeting the bare Agent without those options is not a valid
discovery evaluation.

Discovery observability is content-minimizing by default. Production logs may
record query length plus the original ranked tool ids and finite scores, but
never the raw query, tool schemas, or credentials. The exact query is available
only to an explicit in-memory observer used by the opt-in live evaluation; it
is neither logged nor persisted. The live evaluation also records the final
tool choice and scorer verdict so a retrieval success cannot be mistaken for a
successful model decision.

The telemetry wrapper clones Mastra's `search_tools` value with its original
prototype and complete own-property descriptors, then replaces only the
description and executor on that fresh clone. It never mutates or wraps the
Mastra-owned value in place. Mastra 1.51 context storage is also pinned as
empty-or-complete for approval resume: its same-process supplemental set is
additive by thread, while live message-derived names are unioned with that set.
The adapter compatibility test loads two disjoint tools and requires the direct
resume lookup to return both without durable recall. If a future Mastra release
permits a partial non-empty set, update the adapter to merge the post-gate
durable and delegate sets deterministically; do not add a speculative fallback.

Mastra owns the fixed `search_tools` and `load_tool` catalog meta-tool ids;
Brainstrike owns `list_available_tools`. When a surviving
eager/core or deferred definition has an original id whose canonical sanitized
form is any of the three reserved ids (including `search.tools`, `load.tool`,
and `list.available.tools`), a run with deferred catalog
discovery throws `mastra_agent_tool_name_collision` before constructing the
Agent. The error reports only the original, sanitized, and reserved ids. A run
with no deferred definitions installs no catalog processor and preserves a
caller-owned `search_tools` or `load_tool`; never rename the collision, disable
discovery, or widen the eager surface silently.
`load_tool` joined the reserved set in BST-1667 when discovery moved to manual
loading (`search.autoLoad: false`); `MASTRA_CATALOG_META_TOOL_IDS` in
`runtime-assembly/tool-pipeline.ts` is the single list, and the compatibility
tests cover all three ids.
Persisted `load_tool` results (and legacy auto-load `search_tools` results on
threads recorded before BST-1667) reconstruct loaded definitions after restart;
approval and suspended-tool resume rehydrate those definitions from the durable
Mastra thread before the paused call reaches execution. Anonymous calls never
share a default store. A loaded-set shrink within one runtime/thread (for
example, trimming away its discovery result) throws the typed
`mastra_agent_tool_discovery_failure` instead of silently de-loading.
`TOOL_DISCOVERY_FAILURE_CODES` pins the distinct
failure channels as `catalog-miss`, `permission-denied`, `host-unavailable`, and
`unsupported-adapter`; adapters must not collapse them into an empty result.
