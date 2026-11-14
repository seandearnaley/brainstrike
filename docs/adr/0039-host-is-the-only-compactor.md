# ADR-0039: The host is the only compactor; Mastra memory is retired

- **Status:** Accepted
- **Date:** 2026-11-13
- **Tickets:** BST-2523 (decision), BST-2526 (trigger), BST-2533 (removal)
- **Supersedes:** [ADR-0013](0013-observational-memory.md)
- **Amends:** [ADR-0012](0012-ai-sdk-loop-mastra-memory-library.md) (the memory-library clause)

## Context

- Two mechanisms shortened a thread's context, and they were stacked.
  - The host prunes old tool output, summarises whole turns at 90% of the input budget, recovers
    from a provider overflow and trims a request that still does not fit.
  - Mastra's observational memory (OM) ran in front of that. A small model rewrote history into
    observations once 30,000 tokens of messages built up: 16% of a 200K-window budget, 3% of a
    1M-window one.
- OM could not act where a coding thread grows fastest. Its context is frozen for a run so the
  cached prefix stays stable, so an observation applied only from the next run.
- Carrying it cost about 10,700 lines of adapters and tests, a calculator worker, two memory
  tables, a 1,776-line patch on `@mastra/memory` and a 36-line patch on `@mastra/core`. The host
  drove it through a turn API Mastra marks internal.
- Its published evidence is LongMemEval: recall across chat sessions, with no tool calls and no
  comparison against plain summarising. The CLI host already ran with OM off.
- The owner chose to decide on this evidence, without an on/off measurement (2026-11-13).

## Decision

- **One compactor.** The host's compaction is the only mechanism that replaces a thread's history.
  It stays append-only: a `context.compacted` event changes what the model receives, and the
  thread still shows every message.
- **Trigger.** A thread compacts when its next request reaches 90% of the run's input budget or
  the run's compaction cap, whichever is less, and reclaims toward 7/9 of that trigger.
  - The cap defaults to 200,000 tokens. A person can change it (the setting follows in BST-2526).
  - `deriveContextCompactionThreshold` in `context-budget.ts` is the one derivation.
- **Size.** The request is sized by what was last reported: the provider's input tokens on the
  branch's latest step, else the host's own count of its latest prepared request, each plus an
  estimate of what was committed after it. With nothing reported, the estimate includes the run's
  instructions and tool definitions.
- **Mastra memory is retired.** Observational memory and working memory are removed together:
  `@mastra/memory`, its adapters, the calculator worker, both vendor patches, the memory tables,
  the memory settings and the observation states of the context meter (BST-2533).
  - `@mastra/core` stays for tool search, skills and OpenRouter routing.
  - No compatibility work. The app has no users and Brainstrike is greenfield
    ([ADR-0020](0020-greenfield-data-lifecycle.md)): the `memory.usage` and `memory.cycle` events
    and their ledger kinds are deleted, and a dev profile that holds them is reset.
- **What replaces each memory feature.**
  - Observations: the host's compaction summary.
  - The working-memory scratchpad: the task list and the compaction summary.
  - The `lastMessages` window: none. Every turn on the branch that no compaction covers is sent.
  - Memory across threads: project memory files, decided in their own ADR (BST-2530).

## Consequences

- Until BST-2533 lands, the desktop host still runs observational memory. With it on, a reported
  size is of the request Memory built, which is what ADR-0013 required the trigger to measure, and
  compaction still drops only turns that request holds.
- Between 30,000 tokens and the trigger, requests are larger than they were with OM. Cached input
  is billed at a fraction of the normal rate; a thread idle past the cache lifetime pays the full
  price once. The cap bounds this on large-window models.
- Compaction is checked before every step of a run, not only its first request (BST-2531). A run
  that outgrows its budget part-way through summarizes its own older steps (`through` on
  `context.compacted`), keeping its user message, its newest steps up to the protect window and
  every tool call with its result. Each step's request is built from the committed branch.
  - A request the provider boundary still has to trim commits a deterministic `context.compacted`
    with reason `request-trim`, so no request loses its oldest messages unseen.
  - A mid-run compaction rewrites the request's cached prefix once; no cache logic is added.
- History assembly, the provider-request middleware and the committed transcript read live in the
  memory owner today and are not memory. BST-2533 moves them to Core before deleting anything.
- A provider-native compaction (Anthropic's `compact_*`, OpenAI's `/responses/compact`) is not the
  base: OpenAI's items are encrypted and provider-locked, and the host's cost rows, tool discovery
  and thread card need to see every step. One may be added later as an optimisation.

## Sources

- The 13 Nov 2026 review "Memory and Compaction Review" and Linear project P-BST-82.
- Mastra: `mastra.ai/docs/memory/observational-memory`, `mastra.ai/research/observational-memory`
  (Feb 2026); `mastra-ai/mastra#25372` (open: recent user input lost after an observation
  activates).
- JetBrains Research, "The Complexity Trap" (arXiv 2508.21433): masking old tool output matches
  LLM summarising at about half the cost.
- Factory, "Evaluating compression" (Dec 2025): every summariser is weakest at tracking files.
