# BST-614: Measure provider-native tool search

## Decision boundary

Compare OpenAI and Anthropic hosted tool search with Brainstrike's live Mastra
catalog-search baseline. This slice records evidence and a provider-specific
go/no-go decision; it does not change production discovery routing.

## Plan

1. Pin the exact protocol and adapter capabilities in current official provider
   docs, installed AI SDK/Mastra source, and Brainstrike's discovery contract.
2. Build a disposable, secret-safe capture harness that exercises identical
   tool catalogs and scenarios without logging prompts, credentials, or raw
   workspace content.
3. Run deterministic and live comparisons across GPT-5.6, one additional
   supported OpenAI model, and Claude Sonnet 4.6. Measure visible definition
   tokens, loaded definitions, turns, usage/cache counters, latency, selection,
   misses, retries, and approval preservation.
4. Record the support matrix and decision in
   `docs/agents/assistant-providers.md`. If either provider is a go, create one
   narrowly scoped Linear implementation ticket per provider; otherwise close
   the spike without adding a duplicate runtime.
5. Add a focused contract test for the recorded matrix/decision, run the full
   repository gate once, publish one documentation/research PR, address review,
   and merge only when its required checks are green.

## Scope guards

- No production routing switch or fallback adapter.
- No changes to permissions, approval suspension, persistence, projections, or
  artifact settlement.
- No Gemma/local-model work.
- No credentials or raw provider payloads in committed artifacts.
