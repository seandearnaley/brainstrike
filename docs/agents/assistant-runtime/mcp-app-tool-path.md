# MCP Apps tool path — evidence

Supports `docs/agents/assistant-runtime.md` § "TOOL-PATH WIRING (BST-1572)".
Read before changing `mcp-app-tool-result.ts`, `_meta.ui` detection, the Apps marker shape, or its model projection.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 1127-1173), extracted verbatim.

### TOOL-PATH WIRING (BST-1572)

The ordinary model-initiated MCP tool path now persists the renderer-owned Apps
mount marker when the executing tool definition advertises
`_meta.ui.resourceUri` (`packages/agent/src/mastra/mcp-app-tool-result.ts`,
consumed by `executeMcpTool` in `mcp-runtime-client.ts`):

- **Strict definition detection.** A definition with no own `_meta.ui` member
  is an ordinary MCP tool and is unchanged. A present `_meta.ui` is parsed by
  `parseMcpAppToolMeta` from `@brainstrike/mcp-app-host` before `tools/call`;
  invalid keys, shapes, visibility, size, or a non-`ui://` resource URI throw
  visibly before the remote tool can execute. A valid `ui` object without
  `resourceUri` remains an ordinary result.
- **Ordinary calls only.** The Apps admission executor marks its authority-owned
  abort signal with `retainRawMcpCallToolResult`; that early return remains
  before Apps marker construction and preserves the complete `CallToolResult`
  for preview/authority execution. The marker is built only on the ordinary
  model-initiated path.
- **Ordering and ordinary result.** Created Tasks first settle to their existing
  task marker (except app-originated raw-retention calls, which return the
  CreateTaskResult after `track()` — see the BST-1566 section). For non-task calls the raw successful `CallToolResult` is kept
  when there is no `structuredContent` or when media is present; otherwise the
  existing `structuredContent` value is used. Canonical `isError: true` throws
  before any Apps marker exists. The selected value is exactly the result this
  path returned before BST-1572.
- **Persisted marker and identity.** `createMcpAppToolResult` calls
  `createMcpAppToolInvocationResult` with `serverId = server.name` (the
  configured server id), the unprefixed MCP `toolName`, the strict `ui://`
  `resourceUri`, and `mimeType: 'text/html;profile=mcp-app'`. The raw domain
  result is `{ kind: 'mcp-app', app: { mimeType, resourceUri, serverId,
  toolName }, result: ordinaryResult }`. Existing hook display/transcript
  transforms and bounded artifact settlement preserve this small raw domain
  marker exactly as they do the sibling Tasks marker.
- **Model projection.** Apps metadata never reaches the model.
  `projectMcpAppOrTaskToolModelOutput` composes the Tasks projector with the
  Apps marker reader. The central `toModelOutput` seam unwraps `result` before
  the custom projector and before generic fallback, so a nested task keeps its
  bounded task projection and every other Apps result receives exactly the
  generic projection its `ordinaryResult` would have received without the
  marker. Definitions with neither Tasks capability nor `_meta.ui` retain no
  custom projector.

Tests: the "MCP Apps tool results" block in
`packages/agent/src/__tests__/mcp-runtime-client.spec.ts` pins both ordinary
result shapes, strict metadata failure, unchanged non-Apps tools, `isError`
ordering, persisted marker identity, and marker-free model projection;
`mcp-app-tool-call.spec.ts` pins the unchanged admission executor path.
