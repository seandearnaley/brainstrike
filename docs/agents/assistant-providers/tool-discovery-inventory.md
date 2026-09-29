# Deferred tool inventory — evidence

Supports `docs/agents/assistant-providers.md` § "Tool discovery contract (LIVE for hosted Mastra catalog search)". Why `list_available_tools` exists and how the discovery surfaces derive their family list.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5272-5333); append rather than
rewrite.

---

Search results are ranked selections, never an inventory. The 2026-09-04
Linear failure had all 61 tools in the eligible deferred catalog, but a broad
query returned three label/status tools and the model declared issue operations
unavailable. `list_available_tools` therefore exposes the same post-gate,
per-runtime deferred catalog without loading definitions or executing MCP requests.
It supports case-insensitive name prefixes and pages of 50 entries, reports
the matching total and `nextOffset` (null only at the end), and explicitly
marks descriptions shortened to 160 Unicode code points. Eager tools are already
callable and are not included in this deferred inventory. Ordering uses code-unit name
comparison rather than the host locale. Each prefix/offset query is independent;
clients must keep the prefix when following nextOffset. An offset exactly at
the matching count returns the empty end page; an offset beyond it reports a typed pagination error with the offset and matching count.
The name map is total for eligible tools and snapshotted per processor; missing
mappings fail visibly at construction or loaded-tool projection.
Models enumerate with it and
load a capability with `load_tool` using an exact listed name. Inventory
results never enter Mastra's loaded-tool state; search results and instructions
explicitly distinguish ranked matches from the complete catalog. No new store,
remote round trip, or eligibility path is introduced. Processor tests cover
61-tool pagination, runtime isolation, and selective loading; the real Mastra
loop test covers inventory -> search -> execution.

Mastra's BM25 catalog ranks the sanitized tool id plus its canonical
description. Brainstrike's initial `search_tools` description must therefore
name the major deferred capability families explicitly, including open
workspace roots and focused context. Aside from the deliberately critical
create primitive above, do not widen the eager registry to work around a model
that skips discovery. Deterministic ranking fixtures cover the
context/list/read/grep/glob/edit/command intents. The opt-in hosted matrix in
`tool-discovery-live-eval.integration.spec.ts` exercises GPT-5.4 Mini and Claude
Haiku against the real processor and fails visibly when either provider key is
absent.

Hosted default instructions add the discovery guidance only when the runtime
actually installs `BrainstrikeToolSearchProcessor`. They tell the model to load
deferred capability families — `load_tool` by exact name, or `search_tools`
then `load_tool` — before substituting eager glob or shell tools.

**THE DISCOVERY SURFACES NAME EVERY ELIGIBLE DEFERRED FAMILY — AND ONLY
ELIGIBLE ONES.** A deferred capability the prompt never names is a tool the
model declares nonexistent instead of searching for: the 2026-08-23 field
failure dismissed both "the canvas tool" (`manageCanvas`) and a skill
activation's named `runSkillScript` as missing, and worked around the latter
via `executeCommand` — bypassing the typed skill-script policy layer. The
opposite failure is advertising a family the run cannot load (a WEB run's
eligible set excludes canvas/Python/browsers/command sessions/diagnostics/
self-query/skill scripts). Both surfaces — the instructions' discovery line
AND `search_tools`' own tool description — therefore DERIVE their family list
per run from `deferred-capability-families.ts`, the single source; the
`tool-discovery capability coverage` spec pins that every runtime-deferred
native tool (`loadingTier !== 'critical'`, skill ids force-cored) belongs to
a family, that eligible families are named, and that ineligible ones are not.
The line also states that a tool NAMED by the instructions or a skill
activation but not loaded is reachable via `load_tool` by exact name — the prompt names
tools by exact id (`toolNameMap` spans both surfaces) that are not in the
model's callable list until discovered, and without that sentence the model
resolves the contradiction the wrong way.
`BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE` (appended to every skill activation
result, with its space RESERVED inside the activation budget so truncation
can never slice it off) carries the same recovery clause for
`runSkillScript`, self-gated on `load_tool` being available.

