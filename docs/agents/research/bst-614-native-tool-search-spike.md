# BST-614 — provider-native tool-search spike

Date: 2026-07-21
Decision: **keep Mastra catalog search live; do not route production to either
provider-native adapter yet.**

## Executive result

Provider-native search is not a safe drop-in replacement for Brainstrike's
Mastra catalog today:

- OpenAI native search is blocked by a reproducible request-history defect in
  the installed AI SDK adapter. GPT-5.4 Mini and GPT-5.6 Luna both selected and
  loaded the deferred tool, then the second request contained the same
  `tool_search_output` item reference twice. OpenAI rejected both runs with
  `Duplicate item found`. The Mastra baseline completed on both models.
- Anthropic native BM25 search preserved defer-loading, approval suspension,
  execution, and same-process approval resume. However, Claude Sonnet 4.6
  missed the target tool from a normal task prompt. It succeeded only when the
  prompt prescribed a search query matching the tool description. That
  instructed success used essentially the same provider-reported tokens and
  estimated cost as the Mastra baseline.

The current Mastra path is therefore the only measured adapter that is both
provider-independent and task-correct. Native support remains declarative in
the registry; runtime selection must continue to request
`mastra-catalog-search` explicitly.

## Grounded contracts

### Provider documentation

- [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
  is supported on GPT-5.4 and newer. A request adds `type: "tool_search"` and
  marks functions or namespaces `defer_loading: true`. Hosted search returns
  `tool_search_call` and `tool_search_output`; loaded definitions are appended
  so the stable prefix remains cacheable.
- [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
  supplies server BM25 and regex search. Deferred definitions are present on
  the API request but excluded from the model context until returned as tool
  references. Anthropic recommends preserving tool-search history unchanged.
- [Anthropic tool-context guidance](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context)
  treats tool search, programmatic tool calling, prompt caching, and stale-tool
  context editing as complementary mechanisms rather than substitutes.

### Installed runtime and reference agent

- Brainstrike installs Mastra 1.51.0, the current npm release on the spike date,
  plus `@ai-sdk/openai` 4.0.8 and `@ai-sdk/anthropic` 4.0.8. Both SDK adapters
  already expose their provider-native search tools and defer-loading metadata;
  no speculative adapter implementation is needed.
- The latest npm releases checked during the spike were OpenAI 4.0.17 and
  Anthropic 4.0.18. Source inspection of OpenAI 4.0.17 still shows the same
  stored `tool_search` call/result item-reference branches responsible for the
  duplicated id, so a version bump alone is not evidence of a fix.
- OpenCode at local reference HEAD `888c4cb504` has no provider-native
  `tool_search` or `defer_loading` implementation. Its current architecture
  keeps a permission-filtered registry and an experimental code-mode path. It
  is useful evidence for bounded programmatic orchestration (BST-616), not
  evidence that native hosted search is production-ready.

## Method

The disposable Electron-main harness decrypted the existing desktop keys only
in memory and wrapped provider `fetch`. It emitted sanitized counters and
structural metadata only: model, adapter, request count, tool names/types,
defer flags, serialized tool characters, input item types/ids, provider usage,
latency, tool selections, suspension state, and synthetic executions. It did
not print or persist credentials, prompts from real threads, raw provider
responses, or workspace content.

Each adapter received the same synthetic post-policy catalog: one semantic
source lookup, one approval-gated edit, twelve unrelated deferred functions,
and provider/Mastra search control. Tool implementations returned tiny fixed
objects. This isolates discovery and lifecycle behavior from filesystem or
network variance.

## Live measurements

Provider cost estimates use the rates in Brainstrike's model registry; they are
comparative estimates, not invoices.

| Provider / model | Adapter | Outcome | Requests / steps | Provider usage | Latency | Estimated cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| OpenAI GPT-5.4 Mini | Mastra | selected and executed `semantic_lookup` | 3 / 3 | 896 in, 55 out | 7.21 s | $0.000334 |
| OpenAI GPT-5.4 Mini | native | **failed**: duplicate `tso_…` item reference on request 2 | 2 / incomplete | incomplete | 2.0–10.4 s | not comparable |
| OpenAI GPT-5.6 Luna | Mastra | selected and executed `semantic_lookup` | 3 / 3 | 1,026 in, 66 out | 5.45 s | $0.001422 |
| OpenAI GPT-5.6 Luna | native | **failed**: duplicate `tso_…` item reference on request 2 | 2 / incomplete | incomplete | 4.2 s | not comparable |
| Anthropic Claude Sonnet 4.6 | Mastra | selected and executed from normal task prompt | 3 / 3 | 3,185 in, 183 out | 6.05 s | $0.012300 |
| Anthropic Claude Sonnet 4.6 | native, normal prompt | **missed** the eligible target and stopped | 1 / 1 | 1,539 in, 100 out | 4.31 s | $0.006117, but incorrect |
| Anthropic Claude Sonnet 4.6 | native, prescribed search query | selected and executed | 2 / 2 | 3,211 in, 182 out | 5.45 s | $0.012363 |
| Anthropic Claude Sonnet 4.6 | native, approval + resume | suspended before edit, approved, executed once | 2 / 2 | 3,362 in, 210 out | 5.82 s | $0.013236 |

Wire-size observations are intentionally separated from billed/model context:

- OpenAI native sent 3,933 serialized tool characters for thirteen deferred
  functions plus search; Mastra initially sent 565 and later 1,408 after loading.
- Anthropic native sent 3,775 serialized tool characters, as documented, while
  provider-reported input excluded deferred schemas from model context. Mastra
  initially sent 549 and later 1,344 after loading.
- Anthropic native saved one model turn only after stronger search-query
  instructions. It did not produce a token or cost win in that successful run.

## Scenario disposition

| Required scenario | Result | Why no broader rollout run was justified |
| --- | --- | --- |
| Exact workspace lookup / semantic retrieval | Mastra passed all three models; OpenAI native failed; Anthropic native missed the normal prompt | Foundational quality/transport gate failed |
| Read → approval-gated edit | Anthropic native suspended before execution and approval resume executed exactly once | Lifecycle seam is compatible on Anthropic |
| Resumed thread | Same-process Anthropic approval resume passed; OpenAI could not reach resume because history serialization failed | Cross-restart persistence still requires an implementation slice |
| Web research / MCP | Both are ordinary post-policy deferred tools after provider-owned web-search handling | Running more paid variants cannot overcome the failed foundational gate |
| Catalog miss | Anthropic normal-prompt run produced a visible miss and no execution | Miss remained distinct from permission denial |
| Permission denied | Admission remains upstream of either adapter; denied tools are omitted from the provider catalog | Must stay a deterministic pre-provider contract, not a model eval |

The suite stopped after the failed foundational gate instead of spending across
every permutation. This is a fail-fast measurement decision, not an inference
that unrun scenarios passed.

## Recommendation and next gates

1. Keep the live Mastra catalog adapter and its fail-loud persistence wrapper.
2. Do not add a runtime fallback. A native adapter may become selectable only
   after its own explicit implementation and regression matrix passes.
3. OpenAI (BST-680): first obtain an AI SDK serialization fix (or an
   upstream-supported request-history contract), then add a captured-request
   regression proving one reference per provider item before rerunning live
   models.
4. Anthropic (BST-681): first pin native-search instructions and run a diverse prompt
   corpus. Require non-inferior selection/miss behavior and an actual token or
   cost win. Then prove cross-restart discovery history, denied-tool omission,
   MCP, provider web search, and approval resume in Brainstrike's persisted
   runtime.
5. Do not combine either provider rollout with stale-history filtering
   (BST-615) or code-mode orchestration (BST-616). Those mechanisms solve
   different context costs and deserve independent, reversible PRs.

No production route, permission, persistence, projection, or tool definition
changed in this spike.
