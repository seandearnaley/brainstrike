# Mastra Agent System Docs Catch-Up

Date: 2026-05-29

Linear project: [Mastra Agent System Docs Catch-Up](https://linear.app/brainstrike/project/mastra-agent-system-docs-catch-up-1f80fa0cdebe)

## Scope

This audit cross-checked Brainstrike's Mastra-backed assistant system against current Mastra docs for:

- Agents
- Memory
- Workflows
- Editor
- Streaming
- MCP
- Workspaces
- Browser
- Server
- Deployment
- Observability
- Evals

The investigation used five specialist read-only passes across adjacent areas and intentionally kept Linear footprint small: one high-level issue per slice, with checklist subtasks inside the issue description instead of separate child issues.

## Executive Summary

Brainstrike has a real Mastra integration: `Agent`, streaming, MCP, and PGlite-backed Mastra memory are already in use. The main deficit is that Brainstrike wraps Mastra behind custom runtime, stream, server, MCP, and UI contracts that now lag current May 2026 Mastra APIs.

The shortest path would be to patch individual bugs, but that would leave the same architectural drift in place. The better path is a staged catch-up:

1. Upgrade and widen the Mastra runtime compatibility boundary.
2. Fix the concrete stream/tool-call and request parsing bugs.
3. Decide where official Mastra Workflows, Editor, Workspaces, Server, Observability, and Evals should replace bespoke Brainstrike plumbing.
4. Preserve local-first desktop constraints explicitly: PGlite, keychain secrets, loopback-only desktop server, hidden renderer local LLM/embedding hosts, and UI context selection remain valid reasons for custom integration.

## Linear Issues Created

- [BST-557](https://linear.app/brainstrike/issue/BST-557/mastra-2026-catch-up-upgrade-runtime-surface-enforce-agent-approval): Mastra 2026 catch-up: upgrade runtime surface, enforce agent approval, and align memory options
- [BST-558](https://linear.app/brainstrike/issue/BST-558/evaluate-mastra-workflows-and-editor-adoption-for-brainstrike): Evaluate Mastra Workflows and Editor adoption for Brainstrike assistant orchestration
- [BST-559](https://linear.app/brainstrike/issue/BST-559/modernize-mastra-streaming-and-mcp-integration-to-current-standard): Modernize Mastra streaming and MCP integration to current standard APIs
- [BST-560](https://linear.app/brainstrike/issue/BST-560/audit-and-align-brainstrike-assistant-runtime-with-mastra-workspaces): Audit and align Brainstrike assistant runtime with Mastra Workspaces, Browser, and Server capabilities
- [BST-561](https://linear.app/brainstrike/issue/BST-561/mastra-deployment-observability-and-eval-architecture-catch-up): Mastra deployment, observability, and eval architecture catch-up

## High-Confidence Findings

### Runtime and Approval

Brainstrike currently uses `@mastra/core` 1.25.0, `@mastra/mcp` 1.5.0, and `@mastra/memory` 1.16.0. Current Mastra docs include newer agent capabilities such as background tasks and richer approval/stream surfaces.

Evidence:

- `packages/agent/package.json`
- `packages/agent/src/mastra/agent-runtime.ts`
- Mastra docs: https://mastra.ai/docs/agents/overview
- Mastra docs: https://mastra.ai/docs/agents/agent-approval
- Mastra docs: https://mastra.ai/docs/agents/background-tasks

Brainstrike has tool approval metadata and prompt guidance, but the runtime does not enforce Mastra Agent Approval. The wrapper only forwards a narrow stream option set and drops unknown stream events by default. This is a correctness and safety gap for state-changing tools.

### Memory

The custom PGlite Mastra memory adapter is justified by Brainstrike's local-first architecture. There is no official PGlite provider in the docs, so this should not be replaced blindly. It does need conformance coverage against current Mastra memory behavior, especially message history, working memory, semantic recall, observational memory, and multi-user thread constraints.

Evidence:

- `packages/agent/src/pglite-mastra-memory/memory-factory.ts`
- `packages/agent/src/pglite-mastra-memory/memory-store.ts`
- `packages/assistant-contract/src/mastra-memory-schema.ts`
- Mastra docs: https://mastra.ai/docs/memory/overview

### Workflows and Editor

Brainstrike is intentionally agent-first for open-ended assistant chat. That is coherent. The concern is not "use workflows everywhere"; it is that workflow/editor-adjacent behavior already exists in bespoke form: approval, run timelines, prompt management, MCP tool selection, and thread run persistence.

Evidence:

- `packages/agent/src/mastra/default-instructions.ts`
- `packages/agent/src/stream/data-stream-mapper.ts`
- `packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx`
- `packages/ui/src/prompt-management/store.ts`
- `packages/ui/src/prompt-management/components/prompt-editor.tsx`
- Mastra docs: https://mastra.ai/docs/workflows/overview
- Mastra docs: https://mastra.ai/docs/editor/overview

The Prompt Library appears to overlap with Mastra Editor's versioned prompts/agent overrides, and one local restore control appears incomplete. That should be evaluated before adding more custom prompt state.

### Streaming and MCP

The custom stream mapper has at least one likely bug: a successful non-streaming `tool-call` followed by `tool-result` can emit the result without first emitting the completed AI SDK tool-call args. Existing tests cover streaming args and error completion, but not the ordinary successful non-streaming path.

Evidence:

- `packages/agent/src/stream/data-stream-mapper.ts`
- `packages/agent/src/__tests__/data-stream-session.spec.ts`
- `packages/agent/src/__tests__/mastra-streaming.spec.ts`
- Mastra docs: https://mastra.ai/docs/streaming/overview
- Mastra docs: https://mastra.ai/docs/streaming/events

MCP is split between runtime `@mastra/mcp` and custom desktop stdio/SSE clients. The desktop SSE client does not support normal `listTools()`, lifecycle cleanup is unclear on shutdown, and runtime tool filtering uses heuristics rather than current dynamic `toolsets` patterns.

Evidence:

- `packages/agent/src/mcp/config.ts`
- `packages/agent/src/mastra/mcp-tool-loader.ts`
- `apps/desktop/src/mcp/sse-client.ts`
- `apps/desktop/src/mcp/index.ts`
- `apps/desktop/src/ipc-mcp.ts`
- `apps/desktop/src/main.ts`
- Mastra docs: https://mastra.ai/docs/mcp/overview
- Mastra reference: https://mastra.ai/reference/tools/mcp-client

### Workspaces, Browser, and Server

Mastra Workspaces now overlap heavily with Brainstrike's desktop tools for filesystem access, search, and command-like operations. Brainstrike's custom tools are still justified where they touch PGlite, embedding host IPC, workspace index state, and UI context broadcasts. That boundary should be documented and tested.

Mastra Browser is not integrated. That is not automatically a bug; it only matters if Brainstrike wants browser-driving agents. It should be handled as a product decision and kept distinct from Brainstrike's existing "browser runtime" terminology for local in-browser inference.

Web and desktop assistant routes are divergent. Web silently treats invalid JSON as an empty object; desktop handles invalid JSON explicitly but has its own body parsing path. A shared request parsing contract should be fixed before deeper server refactors.

Evidence:

- `apps/web/src/app/api/assistant/route.ts`
- `apps/desktop/src/assistant-server.ts`
- `apps/desktop/src/assistant-server/http.ts`
- `apps/desktop/src/assistant-server/assistant-tools.ts`
- `packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts`
- Mastra docs: https://mastra.ai/docs/workspace/overview
- Mastra docs: https://mastra.ai/docs/browser/overview
- Mastra docs: https://mastra.ai/docs/server/mastra-server

### Deployment, Observability, and Evals

There is no canonical Mastra app/deployment boundary. The repo has custom web and desktop paths rather than a clearly registered Mastra app root that owns agents, storage, observability, scorers, and server behavior.

Mastra observability is not integrated. Brainstrike has Pino logs and custom run-event persistence, but it does not get Mastra traces, correlated logs, token/cost metrics, or scorer results tied to runs.

The eval harness is retrieval-only and bespoke. It should not be thrown away, but it should be complemented by Mastra scorers and CI eval entrypoints for agent/tool quality.

Evidence:

- `package.json`
- `apps/web/vercel.json`
- `apps/desktop/src/assistant-server.ts`
- `packages/utils/src/logger.ts`
- `packages/agent/src/evaluation/harness.ts`
- `packages/agent/src/evaluation/types.ts`
- Mastra docs: https://mastra.ai/docs/deployment/overview
- Mastra docs: https://mastra.ai/docs/observability/overview
- Mastra docs: https://mastra.ai/docs/evals/overview
- Mastra docs: https://mastra.ai/docs/evals/running-in-ci

## Recommended Order

1. Fix concrete correctness bugs first: stream tool-call/result emission and shared request parsing.
2. Upgrade Mastra packages and establish an explicit runtime compatibility boundary.
3. Implement enforceable tool approval using official Mastra approval or workflow HITL semantics.
4. Decide the canonical Mastra app/server boundary for web and desktop.
5. Add observability and scorer/eval integration after the app boundary is clear.
6. Evaluate Editor, Workspaces, and Browser as product/architecture choices rather than opportunistic package additions.

## Intentionally Not Opened as Separate Linear Issues

- Supervisor agents, channels, A2A/ACP, response caching, and background tasks were not opened as separate issues. They are covered under BST-557 as support/out-of-scope decisions.
- Mastra Browser was not opened as a standalone implementation issue. It is covered under BST-560 because product requirements for browser-driving agents are not yet established.
- PGlite memory replacement was not opened. The audit found the custom adapter justified by local-first constraints; the issue is conformance and upgrade safety, not replacement.
