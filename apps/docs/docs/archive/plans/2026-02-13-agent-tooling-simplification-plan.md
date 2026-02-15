# Agent Tooling Simplification Plan (Design First)

Date: 2026-02-13
Owner: Assistant tooling
Status: Proposed (pre-implementation)

## Goals

1. Strip the native tool surface down to a beginner-friendly, minimal set.
2. Replace implicit context packing assumptions with explicit context toggles.
3. Keep context/token behavior visible and predictable.
4. Support batch selection workflows for both:
   - Left root file tree selection state
   - Context explorer file selection state

## Tools To Remove

Remove these native tools from registration, descriptions, schema display, and settings surfaces:

- `brainstrike.retrieveContext`
- `brainstrike.hybridSearch`
- `brainstrike.queueStatus`
- `brainstrike.packContext`
- `brainstrike.listEmbeddingSets`
- `brainstrike.createEmbeddingSet`
- `brainstrike.createSelectionScope`
- `brainstrike.queryFileTree`
- `brainstrike.importFiles`
- `brainstrike.systemDiagnostics`
- `brainstrike.reembedCollection`
- `web.searchDocs`
- `web.docSummary`

## New Minimal Tool Set

### 1) `brainstrike.readWorkspaceFile`

Purpose:
- Read one file from the currently selected workspace root.

Input (strict):
- `path: string` (required, workspace-relative)
- `maxBytes: number | null` (optional, default `32768`, hard cap `262144`)
- `encoding: "utf8" | "base64" | null` (optional, default `"utf8"`)

Output:
- `path: string`
- `size: number`
- `encoding: "utf8" | "base64"`
- `content: string`
- `truncated: boolean`

Notes:
- Must resolve path under selected root only.
- Return descriptive validation errors for missing root or invalid path traversal.

### 2) `brainstrike.readWorkspaceDirectory`

Purpose:
- Token-efficient directory and file listing from selected root.

Input (strict):
- `path: string | null` (optional, workspace-relative, default root)
- `mode: "files" | "directories" | "mixed" | null` (default `"mixed"`)
- `maxEntries: number | null` (default `200`, hard cap `1000`)
- `maxDepth: number | null` (default `2`, hard cap `6`)
- `includeHidden: boolean | null` (default `false`)
- `nameContains: string | null` (optional)

Output:
- `root: string`
- `entries: Array<{ path: string; type: "file" | "directory"; size?: number }>`
- `returnedCount: number`
- `truncated: boolean`

Notes:
- Stable sort (`directories first`, then lexical).
- Must include `truncated` when caps are hit.

### 3) `brainstrike.batchSelectWorkspaceFiles`

Purpose:
- Batch update file selections in UI state with explicit scope.

Input (strict):
- `paths: string[]` (required, workspace-relative, deduped)
- `operation: "set" | "add" | "remove"` (required)
- `scope: "rootTree" | "contextExplorer" | "both"` (required)

Output:
- `operation: "set" | "add" | "remove"`
- `scope: "rootTree" | "contextExplorer" | "both"`
- `requestedCount: number`
- `appliedCount: number`
- `ignoredCount: number`

Notes:
- This is a state-changing tool and should require explicit approval.
- Implementation uses an event from main -> renderer to apply selections immediately.

## Context Inclusion Redesign

Replace current context indicators with two explicit toggles in assistant controls:

- `Include File Report`
- `Include File Tree`

These use the same report generation pathway currently used by report export/copy:
- same report structure (`<report>`, `<relevant_files>`, optional `<project_tree>`)
- same file inclusion/filter behavior

### Context Data Flow

1. In renderer, build context payload from selected files and root using report-generation pipeline.
2. Apply toggles:
   - Report only: include `<relevant_files>` section
   - Tree only: include `<project_tree>` section
   - Both: include both sections
3. Add generated context payload into assistant request data.
4. Server injects this payload as a bounded system context segment.

## Token Budget + UX Rules

Keep token visibility explicit:

- Show `Context Tokens` and `Budget` in a compact table row.
- Compute context token estimate from generated context text (not just selected count).
- Highlight states:
  - `Within budget`
  - `Near budget` (>= 85%)
  - `Over budget` (> 100%)

Beginner-first behavior:
- If over budget, show one-click action to reduce context:
  - disable tree
  - reduce file set via batch select (`set` to top N files by relevance/size policy)

## Settings / Tools Panel Layout

Move tools preferences to a consistent table layout (desktop + web):

Columns:
- `Tool`
- `What it does`
- `Type` (`Read` / `Write`)
- `Scope`
- `Approval`
- `Enabled`

Grouping:
- Core Workspace Tools (these three)
- MCP Tools (if present)

No nested submenu stacks for core tools in the assistant controls menu.

## Architecture Changes (Planned Files)

Primary touchpoints:

- `/Users/seandearnaley/Documents/GitHub/brainstrike/packages/agent/src/registry/tool-categories.ts`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/packages/agent/src/registry/tool-descriptions.ts`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/packages/agent/src/registry/tool-schemas-display.ts`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/packages/agent/src/tools/schemas.ts`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/packages/agent/src/mastra/web-tools.ts`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/apps/desktop/src/assistant-server/assistant-tools.ts`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/apps/desktop/src/assistant-server.ts`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/apps/desktop/src/preload.ts`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/apps/desktop/src/types/electron.d.ts`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/packages/app-shell/src/assistant-ui-panel-wrapper.tsx`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/apps/desktop/src/renderer/components/settings/page-content.tsx`
- `/Users/seandearnaley/Documents/GitHub/brainstrike/apps/web/src/app/settings/page-content.tsx`

## Best-Practice Inputs Used

Tool design and runtime behavior recommendations for implementation:

- Use strict schemas and clear tool descriptions.
- Limit parallel tool calls for deterministic UI-impacting operations.
- Keep human-in-the-loop confirmations for state-changing tools.
- Surface clear visual indicators when tools are invoked.
- Keep request/runtime context typed and validated at runtime.

## External References (2026-02-13)

Reviewed current primary-source guidance and aligned this design with it:

- OpenAI Function Calling guide: [https://platform.openai.com/docs/guides/function-calling](https://platform.openai.com/docs/guides/function-calling)
  - Prefer `strict` schemas and explicit parameter contracts.
- OpenAI Responses API reference: [https://platform.openai.com/docs/api-reference/responses/create](https://platform.openai.com/docs/api-reference/responses/create)
  - Be intentional about `parallel_tool_calls` when tools can mutate UI state.
- OpenAI Responses vs Chat Completions: [https://platform.openai.com/docs/guides/responses-vs-chat-completions](https://platform.openai.com/docs/guides/responses-vs-chat-completions)
  - Keep new agent integrations on the Responses-first architecture.
- Anthropic tool-use implementation guide: [https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)
  - Use explicit `input_schema` and concise tool descriptions to improve reliability.
- Anthropic long-context tips: [https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips)
  - Structure context blocks clearly and keep irrelevant content out.
- Model Context Protocol tools spec: [https://modelcontextprotocol.io/specification/2025-06-18/server/tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
  - Classify read vs write actions clearly (`readOnlyHint`/approval patterns).
- Mastra tools with agents docs: [https://mastra.ai/docs/agents/using-tools-with-agents](https://mastra.ai/docs/agents/using-tools-with-agents)
  - Keep tool interfaces strongly typed and small for predictable orchestration.

## Applied Decisions From Research

- Reduced first-party native tools to 3 focused workspace tools.
- Kept read operations (`readWorkspaceFile`, `readWorkspaceDirectory`) separate from mutation (`batchSelectWorkspaceFiles`).
- Added explicit context inclusion toggles (`Include File Report`, `Include File Tree`) and visible context-token budget status.
- Kept batch selection tool approval-oriented and explicit about target surfaces (`leftRootFileTree`, `contextExplorer`, `both`).
- Retained strict runtime input validation and bounded output controls (depth, entry, and content limits) for token efficiency.

## Rollout Plan

1. Replace native registry metadata with the new 3-tool set.
2. Implement desktop tool executors for the new tools.
3. Add renderer event bridge for `batchSelectWorkspaceFiles`.
4. Implement context toggles + generated context payload.
5. Refactor assistant controls and settings tool panel to table layout.
6. Update tests, then run full suite:
   - `pnpm build`
   - `pnpm lint`
   - `pnpm type-check`
   - `pnpm test`
