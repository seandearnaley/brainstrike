# ADR-0012: One AI SDK loop per run, with Mastra only as a memory library

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914
- **Builds on:** ADR-0001

## Context

Brainstrike runs on Mastra's agent loop with a 606-line vendor patch. In six months
307 merged PRs (13%) touched the Mastra integration or its patch, and 110 of them were
fixes or reverts. The October spikes built the target host on both engines against
real local models; both passed every behavioural check with no vendor patch. As
tested, Mastra's loop with its own memory store wrote observational-memory markers
into Mastra's transcript, a second writer. Mastra's loop with host-driven memory was
not tested.

## Decision

Each run, root or child, is one AI SDK 7 `streamText` loop owned by the host, with
`ai` pinned exactly (7.0.126 at the decision). `@mastra/memory` is used only as a
library, through a host adapter, for observational memory, working memory and
semantic recall; `@mastra/core` stays installed only as its peer. There is no Mastra
HTTP server or server adapter, no Mastra browser runtime without a product decision,
and no second permission or persistence system. Mastra-owned tables are never ALTERed:
Brainstrike state lives in Brainstrike tables.

## Consequences

- The choice rests on cost and fit, not on Mastra's loop failing. The host owns the
  log, approvals, subagents, stop and restart either way (about 8–14K lines).
  Rebuilding what Mastra's loop provides is about 9–13K lines, and the spikes already
  proved the riskiest parts: provider history rules, per-provider tool schemas, tool
  discovery, usage and cost, the MCP adapter, and memory through Mastra's library.
- Deleted with the old path: Mastra's agent loop and processors, the 606-line patch
  and the 4.7K-line PGlite storage adapter. The two paths run side by side for at
  most six weeks, and the old path gets no new features.
- A Mastra server adapter would move ownership of auth, CORS, secrets and the desktop
  loopback lifecycle for no capability Brainstrike lacks. A Mastra browser runtime
  needs a product decision naming which runtime owns browser state, credentials,
  consent, and desktop/web parity.
- ADR-0001 still holds: never import `@mastra/core/harness`, `mastracode` or
  `@mastra/libsql`, and the host owns its loop.
- `@mastra/core` stays Node-only and externalized from browser bundles. Web chat goes
  through a stateless serverless proxy running the AI SDK with hosted models and no
  tools.
- The first engine PR pins `ai` exactly and makes the real-account provider replay a
  required check. OpenCode and Kilo Code run their loops directly on `streamText`.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/mastra-boundary.md:38` (why not Mastra Server), `:69` (subagent host
  lifetime authorizes no server), `:119` (browser scope).
- `docs/agents/assistant-persistence.md:1355` and `:1520` (where state lives).
- `AGENTS.md:42`, the cross-cutting invariant on `@mastra/core`.
- The architecture reset report (2026-10-01): component choices and the engine spike.
