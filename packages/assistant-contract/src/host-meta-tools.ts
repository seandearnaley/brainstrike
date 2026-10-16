/**
 * The model-facing tools a host run carries beside its native catalog: tool
 * discovery and working memory. Their ids are fixed wire names, defined once
 * here so the host that registers them and the renderer that names them read
 * the same strings (a browser-safe home: the owners are Node-only).
 *
 * - `search_tools` and `load_tool` are Mastra's ToolSearchProcessor meta-tool
 *   ids; `list_available_tools` is Brainstrike's deferred catalog beside them
 *   (`@brainstrike/agent`'s deferred-tool catalog).
 * - `updateWorkingMemory` is Mastra Memory's working-memory tool, as
 *   `Memory.listTools()` names it for the host (`hostMemoryTools`).
 *
 * The vendor-owned names are pinned against the vendor by the host's own tests,
 * so a renamed vendor tool fails there rather than reading as a raw id.
 */
export const HOST_META_TOOL_ID = {
  listAvailableTools: 'list_available_tools',
  loadTool: 'load_tool',
  searchTools: 'search_tools',
  updateWorkingMemory: 'updateWorkingMemory',
} as const;

export type HostMetaToolId = (typeof HOST_META_TOOL_ID)[keyof typeof HOST_META_TOOL_ID];
