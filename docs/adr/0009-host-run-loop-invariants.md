# ADR-0009: Run-loop invariants that survive the engine port

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914

## Context

The engine moved from Mastra's loop to one AI SDK `streamText` loop per run
([ADR-0012](0012-ai-sdk-loop-mastra-memory-library.md)). Rules learned on the Mastra loop hold
under any loop:

- A model given no date substituted its training cutoff; an observed run wrote a fabricated date
  into durable working memory.
- Watchdog work (BST-1408, BST-1409, BST-839, BST-1777) separated the stream phases.
- BST-1594 made a guard cancel the work it gave up on.
- An optional-field pair made exclusive by `.refine()` failed 100% of real calls, and rejecting
  bundled fields broke the `brainstrike.manageCanvas` tool.

## Decision

1. **Clock.** The host injects its clock and composes the user's current date into the
   instructions, which stay a pure function of their inputs.
2. **Watchdog phases.** The phase boundary is provider output, not the first part.
   - A running tool is never measured against a provider-silence window.
   - The first-output and inactivity windows stay decoupled.
   - A reasoning delta is not an answer.
   - Each child run has its own watchdog; the parent judges only itself.
3. **Error finish.** An error finish is a failed durable outcome, never a completed run.
4. **Tool guards.** A tool-guard budget is per call. When it expires, the guard cancels the
   abandoned work, keyed by tool-call id.
5. **Strict schemas.** Strict-envelope tool schemas use no cross-field `.refine()`. Union branches
   tolerate the declared cross-action extras; only genuinely unknown keys fail.

## Consequences

- The AI SDK host re-implements each rule. Mastra-specific mechanics (e.g.
  `tool-execution-start`/`-end` chunks not being the phase boundary) do not carry over; the rule
  does.
- The contracts' guards exercised the Mastra path; the engine PR needed equivalent host tests
  built from recorded runtime payloads.
- The host sends OpenAI strict mode. In the spikes, Mastra's ported schema layer broke OpenAI's
  strict rules in 11 places on its own and the host's cleanup brought that to 0, so rule 5
  applies to schemas that must survive that conversion.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/assistant-runtime.md:2183` (date note), `:215` (watchdog phases), `:731`
  (decoupled windows), `:318` (error finish), `:137` (tool-guard cancellation).
- `docs/agents/agent-self-query.md:145` (no cross-field `.refine()`).
- `docs/agents/assistant-providers.md:1957` (union branches tolerate extras).

## Amendment (2026-10-22): the watchdog never judges a running tool

Rule 2's running-tool clause now holds by construction.

- The AI SDK's `onToolExecutionStart`/`onToolExecutionEnd` bracket each tool execution, and the
  watchdog has no window while any runs (the SDK's own `chunkMs` never runs during tool
  execution).
- Removed: the part-inferred `tool-executing` phase and its derived backstop. Each tool is bounded
  by its own guard (rule 4), and a delegated child by its own run.
- Why: an awaited child that waited on a person, or worked longer than the old 635 s backstop,
  used to fail its parent.
- Stored rows keep the `tool-executing` phase value decodable.
