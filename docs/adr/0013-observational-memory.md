# ADR-0013: Observational memory: provider, billing and rewind

- **Status:** Superseded by [ADR-0039](0039-host-is-the-only-compactor.md) (2026-11-13).
  BST-2533 removed observational memory.
- **Date:** 2026-10-02
- **Ticket:** BST-1914

## Context

- Observational memory (OM) is on by default (BST-940).
- Three contract rulings shaped it:
  - which model observes (a privacy question);
  - whether its tokens count as spend;
  - what a rewind does to observations already made (Mastra exposes no partial un-observe).
- The reset keeps OM, working memory and semantic recall through `@mastra/memory` as a library
  ([ADR-0012](0012-ai-sdk-loop-mastra-memory-library.md)); each child run keeps its own OM
  record.
- In the spikes OM wrote no transcript messages, so it is not a second writer.

## Decision

- **Observer:** runs inside the user's selected chat provider. The built-in local Gemma is not a
  candidate.
- **Billing:** OM tokens are billed at the observer model's registry rate and flow into the
  daily-spend guardrail, cross-root usage and ledger analytics.
  - A hosted memory embedder is billed the same way (BST-2226, owner decision 4 on BST-2194):
    each embed call for recall, history indexing or vector observation commits its
    provider-reported tokens as `memory.usage` (`embedding`), priced at the embedder's catalog
    rate (input only).
- **Rewind:** OM residue survives a rewind tombstone. A tombstone is not a deletion.

## Consequences

- At the decision, OM usage rows were estimates that left out the observer's own system prompt
  (about 4.4K tokens per cycle, inferred from code). The host records each observer call's
  provider-reported usage instead.
- Scrubbing observation text after a rewind would be guesswork, so it is not done.
- Mastra's wording for presenting observations cannot be configured, so the host builds a
  coding-specific prompt. Stop also cancels an in-flight observation.
- Compaction was first ported ignoring OM: it measured 37,599 estimated tokens of history against
  7,523 actually sent and still fired. BST-2204 fixed this: the trigger measures the request
  Memory builds and compacts only turns that request holds.
- An embedder whose provider reports no tokens cannot be billed (today: Google's, through the AI
  SDK).
  - The host commits no receipt for these and warns once per hosted model, so the gap is
    visible.
  - An embedder without an official catalog price (`gemini-embedding-001`) reads "cost
    unavailable", never $0.
- 2026-11-01: semantic recall and memory embeddings are removed (the retrieval decision,
  BST-2428), so no embedder is billed and the embedder points above no longer apply.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/assistant-persistence.md:282` (observer target), `:446` (OM spend), `:1003`
  (residue survives a tombstone).
- The architecture reset report (2026-10-01): memory decision and spike findings.
