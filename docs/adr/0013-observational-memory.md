# ADR-0013: Observational memory: provider, billing and rewind

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914

## Context

Observational memory (OM) is on by default (BST-940). Three contract rulings shaped
it: which model observes (a privacy question), whether its tokens count as spend, and
what a rewind does to observations already made, given that Mastra exposes no partial
un-observe. The reset keeps OM, working memory and semantic recall through
`@mastra/memory` as a library (ADR-0012), and each child run keeps its own OM record.
In the spikes OM wrote no transcript messages, so it is not a second writer.

## Decision

- The observer runs inside the user's selected chat provider. The built-in local Gemma
  is not a candidate.
- OM tokens are billed at the observer model's registry rate and flow into the
  daily-spend guardrail, cross-root usage and ledger analytics.
- OM residue survives a rewind tombstone. A tombstone is not a deletion and writes no
  `mind_ops` row.

## Consequences

- Today's OM usage rows are estimates that leave out the observer's own system
  prompt, about 4.4K tokens per cycle (inferred from code, not measured). The host
  records each observer call's provider-reported usage instead.
- Scrubbing observation text after a rewind would be guesswork, so it is not done.
- Mastra's wording for presenting observations cannot be configured, so the host
  builds a coding-specific prompt. Stop also cancels an in-flight observation.
- Compaction today ignores OM: it measured 37,599 estimated tokens of history against
  7,523 actually sent and still fired. It is ported as is and is the first fix to make.
- On the lighter web version, memory features are desktop-only.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/assistant-persistence.md:282` (observer target), `:446` (OM spend),
  `:1003` (residue survives a tombstone).
- The architecture reset report (2026-10-01): memory decision and spike findings.
