# BST-680 — OpenAI native tool-search requalification

Date: 2026-07-21
Decision: **keep Mastra catalog search live; do not enable OpenAI native tool
search.**

## Executive result

The Brainstrike compatibility seam from PR #1861 and the real persisted-history
proof from PR #1862 remove the former duplicate-item blocker. Live GPT-5.4 Mini
and GPT-5.6 Luna runs now preserve distinct `tsc_...` and `tso_...` references,
select the intended deferred tool, and execute it once.

Native search still fails the production-adoption gate. Against the same model,
prompt, thirteen-tool post-policy catalog, schemas, and fixed tool outputs, it
used 69–117% more input tokens and cost an estimated 36–79% more than Mastra.
It saved one model turn in every scenario, but was slower on both GPT-5.4 Mini
scenarios. GPT-5.6 Luna was materially faster only for exact-path lookup; that
isolated latency win does not offset the cross-model token and cost regression.

Production therefore continues to request `mastra-catalog-search` explicitly.
This is a supported no-go, not a fallback: the OpenAI native adapter remains
disabled.

## Grounded implementation state

- PR #1861 added a transient OpenAI-only history processor. It copies the
  response-preserved output item id into the provider option consumed by the
  installed AI SDK, rejects conflicting ids, and never mutates durable rows.
- PR #1862 proved the same contract through real PGlite persistence, Mastra
  hydration, and the actual OpenAI request serializer: each call/output id is
  emitted once and the ids remain distinct.
- `patchedDependencies` remains absent. The compatibility seam has an explicit
  removal condition: delete it after an adopted AI SDK release passes the same
  captured-request regression without the processor.
- Production routing is unchanged and has no runtime fallback between native
  and Mastra discovery.

## Method

A disposable Electron-main harness used the existing encrypted Desktop OpenAI
key in memory. It emitted only sanitized structural evidence: adapter, model,
scenario, request count, tool names, deferred-definition count, serialized tool
characters, provider item ids/types, token usage, latency, and synthetic tool
executions. It did not print or persist credentials, raw responses, real thread
prompts, or workspace content.

Each adapter received the same two normal prompts:

1. semantic discovery of persisted deferred-tool reconstruction; expected tool
   `semantic_lookup`;
2. exact repository-relative file lookup; expected tool `exact_file_read`.

The catalog contained those targets plus eleven plausible distractors. Native
used OpenAI hosted `tool_search` with deferred functions. The control used the
same Mastra `ToolSearchProcessor` configuration as production
(`autoLoad: true`, `topK: 3`, context storage). Every tool returned a tiny fixed
object, isolating discovery from filesystem and network variance. Both adapters
ran with low reasoning effort and a five-step ceiling.

## Live measurements

Cost estimates use Brainstrike's current direct-OpenAI registry rates. They are
comparative estimates, not invoices.

| Model / scenario | Adapter | Correct | Requests | Input / output tokens | Latency | Estimated cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GPT-5.4 Mini / semantic | native | yes | 2 | 2,190 / 130 | 5.56 s | $0.000808 |
| GPT-5.4 Mini / semantic | Mastra | yes | 3 | 1,009 / 100 | 4.10 s | $0.000452 |
| GPT-5.4 Mini / exact | native | yes | 2 | 2,113 / 105 | 3.56 s | $0.000738 |
| GPT-5.4 Mini / exact | Mastra | yes | 3 | 1,219 / 119 | 2.93 s | $0.000543 |
| GPT-5.6 Luna / semantic | native | yes | 2 | 2,102 / 87 | 3.56 s | $0.002624 |
| GPT-5.6 Luna / semantic | Mastra | yes | 3 | 1,247 / 111 | 3.78 s | $0.001913 |
| GPT-5.6 Luna / exact | native | yes | 2 | 2,086 / 82 | 2.80 s | $0.002578 |
| GPT-5.6 Luna / exact | Mastra | yes | 3 | 1,179 / 89 | 4.77 s | $0.001713 |

Structural request capture also confirmed that every native continuation
contained one distinct `tool_search_call` (`tsc_...`) item reference and one
distinct `tool_search_output` (`tso_...`) item reference. Native sent all
thirteen deferred schemas on both requests (5,684 serialized tool characters).
Mastra sent only `search_tools` initially (565 characters), then the selected
top-one or top-three definitions (923–1,525 characters).

## Gate disposition

| Gate | Result |
| --- | --- |
| History serialization | pass on both models; distinct call/output ids, no duplicates |
| Normal-prompt semantic selection | pass on both adapters and models |
| Normal-prompt exact selection | pass on both adapters and models |
| Material token or cost win | **fail**; native increased input tokens and estimated cost in all four comparisons |
| Broad web/MCP/miss/denial/approval/restart matrix | stopped before paid expansion because the economic gate failed |

The broader matrix was intentionally not used to manufacture a rollout case
after the foundational adoption criterion failed. Permission denial remains a
deterministic pre-provider omission contract, and PR #1862 already supplies the
real durable-history transport proof. Those facts do not convert the measured
cost regression into a production benefit.

## Revisit condition

Requalify only after a material provider or SDK change plausibly alters the
economics. The next run must repeat the same paired control first. Expand to
web, MCP, miss, denial, approval, and cross-restart scenarios only if both
supported OpenAI models remain quality-non-inferior and show a consistent
material token, cost, or latency benefit. Until then, keep Mastra live.
