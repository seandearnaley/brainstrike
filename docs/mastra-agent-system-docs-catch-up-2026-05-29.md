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

Post-audit implementation has begun. PRs #1084 through #1100 cover the first concrete correctness slices for stream ordering, request parsing, unsupported stream options, approval visibility, retrieval eval CI, prompt restore, MCP lifecycle/discovery behavior, memory include conformance, pending approval rendering, PGlite workflow snapshot persistence, approval/decline resume actions, Mastra compatibility contracts, the current Mastra runtime package bump, assistant-ui data renderer registration for approval/run-event parts, and durable tool lifecycle run-events. Those PRs reduce immediate defects but do not close the broader runtime, memory, workflow, MCP, server, observability, scorer, or product-adoption decisions.

## Linear Issues Created

- [BST-557](https://linear.app/brainstrike/issue/BST-557/mastra-2026-catch-up-upgrade-runtime-surface-enforce-agent-approval): Mastra 2026 catch-up: upgrade runtime surface, enforce agent approval, and align memory options
- [BST-558](https://linear.app/brainstrike/issue/BST-558/evaluate-mastra-workflows-and-editor-adoption-for-brainstrike): Evaluate Mastra Workflows and Editor adoption for Brainstrike assistant orchestration
- [BST-559](https://linear.app/brainstrike/issue/BST-559/modernize-mastra-streaming-and-mcp-integration-to-current-standard): Modernize Mastra streaming and MCP integration to current standard APIs
- [BST-560](https://linear.app/brainstrike/issue/BST-560/audit-and-align-brainstrike-assistant-runtime-with-mastra-workspaces): Audit and align Brainstrike assistant runtime with Mastra Workspaces, Browser, and Server capabilities
- [BST-561](https://linear.app/brainstrike/issue/BST-561/mastra-deployment-observability-and-eval-architecture-catch-up): Mastra deployment, observability, and eval architecture catch-up

## Post-Audit Implementation Status

This report preserves the original audit findings as the baseline. The follow-up PR stack started addressing the concrete "fix first" items before the broader architecture decisions:

- [PR #1084](https://github.com/seandearnaley/brainstrike/pull/1084) covers the BST-559 stream mapper bug called out under Streaming and MCP.
- [PR #1085](https://github.com/seandearnaley/brainstrike/pull/1085) covers the BST-560 shared assistant request parsing contract called out under Workspaces, Browser, and Server.
- [PR #1086](https://github.com/seandearnaley/brainstrike/pull/1086) covers the BST-557 runtime boundary by rejecting unsupported Mastra stream options instead of silently accepting them.
- [PR #1087](https://github.com/seandearnaley/brainstrike/pull/1087) covers the BST-557 approval-surface slice by surfacing Mastra approval pauses to the UI.
- [PR #1088](https://github.com/seandearnaley/brainstrike/pull/1088) covers the BST-561 retrieval eval CI entrypoint. It does not complete the larger Mastra scorer, observability, or canonical app-boundary work.
- [PR #1089](https://github.com/seandearnaley/brainstrike/pull/1089) covers the BST-558 prompt restore slice. The broader Mastra Editor adoption decision remains open, and advanced prompt model settings were split to [BST-567](https://linear.app/brainstrike/issue/BST-567/expose-full-prompt-model-settings-in-editor).
- [PR #1090](https://github.com/seandearnaley/brainstrike/pull/1090) covers the BST-559 desktop MCP lifecycle cleanup slice.
- [PR #1091](https://github.com/seandearnaley/brainstrike/pull/1091) covers the BST-557 PGlite memory include-window conformance slice.
- [PR #1092](https://github.com/seandearnaley/brainstrike/pull/1092) covers the BST-559 grouped MCP toolset discovery slice, including visible diagnostics for missing configured toolsets.
- [PR #1093](https://github.com/seandearnaley/brainstrike/pull/1093) covers the BST-557 approval bridge slice by mapping valid Mastra approval pauses into structured pending approval data instead of terminal tool errors.
- [PR #1094](https://github.com/seandearnaley/brainstrike/pull/1094) covers the BST-557 approval UI slice by rendering pending approval notices in assistant messages.
- [PR #1095](https://github.com/seandearnaley/brainstrike/pull/1095) covers the BST-557 PGlite workflow snapshot slice by registering a transaction-backed Mastra `WorkflowsStorage` domain for persisted approval/workflow resume state.
- [PR #1096](https://github.com/seandearnaley/brainstrike/pull/1096) covers the BST-557 approval-resume action slice by wiring UI approve/decline actions through the desktop assistant server to Mastra `approveToolCall` / `declineToolCall` and returning explicit unsupported-action errors on web.
- [PR #1097](https://github.com/seandearnaley/brainstrike/pull/1097) covers the BST-557 compatibility-contract slice by enforcing latest Mastra memory `resourceId` thread lookup, workflow run lookup by globally unique `runId`, and grouped MCP toolset discovery.
- [PR #1098](https://github.com/seandearnaley/brainstrike/pull/1098) covers the BST-557 Mastra package-bump slice by updating `@mastra/core`, `@mastra/mcp`, and `@mastra/memory` to the current npm releases, refreshing the lockfile, and preserving desktop IPC early validation before agent-module startup.
- [PR #1099](https://github.com/seandearnaley/brainstrike/pull/1099) covers the BST-557 assistant-ui data renderer slice by registering Brainstrike run-event and tool-approval data parts through the official assistant-ui `useAssistantDataUI` hook, with manual desktop approval-flow smoke coverage.
- [PR #1100](https://github.com/seandearnaley/brainstrike/pull/1100) covers the BST-561 observability bridge slice by emitting durable `tool.started`, `tool.completed`, and `tool.failed` run-events from Mastra tool lifecycle stream parts without persisting raw args, results, outputs, or error payloads. It does not add Mastra observability packages, scorers, or a canonical Mastra app/server boundary.

The remaining architectural work is still the staged work in BST-557 through BST-561: runtime hardening, official workflow HITL semantics, canonical Mastra app/server boundary, observability, scorers, and product decisions around Editor, Workspaces, and Browser.

## High-Confidence Findings

### Runtime and Approval

Brainstrike currently uses `@mastra/core` 1.25.0, `@mastra/mcp` 1.5.0, and `@mastra/memory` 1.16.0. Current Mastra docs include newer agent capabilities such as background tasks and richer approval/stream surfaces.

Evidence:

- `packages/agent/package.json`
- `packages/agent/src/mastra/agent-runtime.ts`
- Mastra docs: https://mastra.ai/docs/agents/overview
- Mastra docs: https://mastra.ai/docs/agents/agent-approval
- Mastra docs: https://mastra.ai/docs/agents/background-tasks

Brainstrike has tool approval metadata and prompt guidance. The current PR stack now rejects unsupported stream options, surfaces valid approval pauses as pending data, renders those pending approvals through assistant-ui data renderers, adds a PGlite-backed `WorkflowsStorage` domain for workflow snapshots, and wires approve/decline resume actions through the desktop assistant server. This does not yet settle the broader package/runtime compatibility boundary or whether official workflow HITL should replace more bespoke assistant orchestration.

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

Baseline finding, implemented later in follow-up PR #1084: the custom stream mapper had a bug where a successful non-streaming `tool-call` followed by `tool-result` could emit the result without first emitting the completed AI SDK tool-call args. The report branch preserves the original audit evidence below; the post-audit implementation status above tracks the follow-up fix.

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

## 2026-05-30 Specialist Follow-Up

Additional specialist passes narrowed the remaining work into one code-ready observability bridge and three architecture gates:

- Workflow/HITL: Brainstrike is now aligned enough with Mastra pre-execution agent approval. The remaining gap is runtime `tool-call-suspended` / `resumeStream()` support, which should wait for a product decision on how arbitrary `resumeSchema` inputs are rendered and submitted in the UI.
- Server/Deployment: Brainstrike currently embeds Mastra as an agent runtime behind custom web and desktop assistant HTTP surfaces. Mastra Server/Deployment docs describe a generated Hono/server-adapter architecture. A follow-up implementation should first decide whether Brainstrike keeps its current assistant boundary or adopts Mastra Server/Adapters for web, desktop, or both.
- Observability/Evals: PR #1100 adds the safe, code-ready bridge from Mastra tool lifecycle parts into existing Brainstrike run-event persistence. Full Mastra Observability/Evals/Scorers integration still needs a decision on whether Brainstrike creates a canonical `Mastra` app instance with logger/storage/observability/scorers, or keeps Pino/run-events/retrieval evals as the source of truth with thin Mastra adapters.
- Do not add `@mastra/evals`, Mastra observability packages, scorer registration, or storage-domain migrations until the canonical app/server boundary is decided.

## Recommended Order

Current PR stack status: steps 1 and 2 have partial implementation PRs in flight, #1088/#1089 cover targeted eval and prompt-editor slices, and #1100 covers the first safe observability bridge. The sequence below remains the recommended architecture order for the remaining work.

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
