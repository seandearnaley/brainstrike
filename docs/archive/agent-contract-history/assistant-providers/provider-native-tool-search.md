# Provider-native tool search — evidence

Supports `docs/agents/assistant-providers.md` § "Provider-native decisions". The measured OpenAI and Anthropic results and the economic gate they failed.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5426-5462); append rather than
rewrite.

---

Provider-native support is declarative, not live. The measured decision remains
`mastra-catalog-search` for every hosted production route:

- OpenAI GPT-5.4 Mini and GPT-5.6 Luna both reached native hosted search, then
  failed on the second request because the AI SDK serialized the same stored
  `tool_search_output` item reference twice. OpenAI rejected the request as a
  duplicate item. The latest available OpenAI adapter source retained the same
  branch, so a version bump is not an accepted fix without a captured-request
  regression.
- Anthropic Claude Sonnet 4.6 preserved deferred definitions, approval
  suspension, execution, and approval resume. It missed the target tool from a
  normal task prompt, however, and succeeded only when instructed to issue a
  search query matching the tool description. That successful run had no
  material token/cost advantage over the Mastra baseline.
- The identical Mastra catalog scenario selected and executed the target on all
  three models. Do not trade this quality floor for a smaller unsuccessful
  request or a one-turn improvement that needs answer-specific prompting.

BST-680 subsequently removed OpenAI's duplicate-item blocker without a patched
dependency. Live GPT-5.4 Mini and GPT-5.6 Luna native runs then selected and
executed both semantic and exact-path targets with distinct `tsc_...` and
`tso_...` references. Production adoption still failed its paired economic
gate: compared with the same Mastra catalog, native used 69–117% more input
tokens and cost an estimated 36–79% more across all four comparisons. It was
also slower on both GPT-5.4 Mini scenarios; Luna's isolated exact-path latency
win was not a consistent cross-model advantage. The broader paid matrix stopped
at that failed gate. The full measurements and revisit condition are in
`docs/archive/agent-contract-history/research/bst-680-openai-native-tool-search-requalification.md`.

There is no fallback between discovery adapters. A future provider-native slice
must be selected explicitly and independently prove provider-history
serialization, normal-prompt selection/miss quality, post-policy catalog
admission, MCP/provider-web coexistence, approval suspension, durable restart
resume, cache behavior, and non-inferior token/cost measurements. The complete
evidence and live tables are in
`docs/archive/agent-contract-history/research/bst-614-native-tool-search-spike.md` and
`docs/archive/agent-contract-history/research/bst-680-openai-native-tool-search-requalification.md`.
