# ADR-0009: Run-loop invariants that survive the engine port

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914

## Context

The engine moves from Mastra's loop to one AI SDK `streamText` loop per run
(ADR-0012). The current contracts hold rules learned on the Mastra loop, and these
hold under any loop. A model given no date substituted its training cutoff, and an
observed run wrote a fabricated date into durable working memory. Watchdog work
(BST-1408, BST-1409, BST-839, BST-1777) separated the stream phases, and BST-1594 made
a guard cancel the work it gave up on. An optional-field pair made exclusive by
`.refine()` failed 100% of real calls, and rejecting bundled fields broke the
`brainstrike.manageCanvas` tool.

## Decision

1. The host injects its clock and composes the user's current date into the
   instructions, which stay a pure function of their inputs.
2. The watchdog's phase boundary is provider output, not the first part. A running
   tool is never measured against a provider-silence window, the first-output and
   inactivity windows stay decoupled, and a reasoning delta is not an answer. Each
   child run has its own watchdog, and the parent judges only itself.
3. An error finish is a failed durable outcome, never a completed run.
4. A tool-guard budget is per call. When it expires, the guard cancels the abandoned
   work, keyed by tool-call id.
5. Strict-envelope tool schemas use no cross-field `.refine()`. Union branches tolerate
   the declared cross-action extras, and only genuinely unknown keys fail.

## Consequences

- The AI SDK host re-implements each rule. Mastra-specific mechanics, such as
  `tool-execution-start`/`-end` chunks not being the phase boundary, do not carry over;
  the rule does.
- The contracts' current guards exercise the Mastra path. The engine PR needs
  equivalent tests on the host, built from recorded runtime payloads.
- The host sends OpenAI strict mode. In the spikes, Mastra's ported schema layer broke
  OpenAI's strict rules in 11 places on its own, and the host's cleanup brought that to
  0, so rule 5 applies to schemas that must survive that conversion.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/assistant-runtime.md:2183` (date note), `:215` (watchdog phases),
  `:731` (decoupled windows), `:318` (error finish), `:137` (tool-guard cancellation).
- `docs/agents/agent-self-query.md:145` (no cross-field `.refine()`).
- `docs/agents/assistant-providers.md:1957` (union branches tolerate extras).
