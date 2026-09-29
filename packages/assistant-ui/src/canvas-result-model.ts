import {
  denormalizeNativeToolName,
  isLinkableCanvasId,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';

/**
 * Display-side narrowing of a settled `manageCanvas` create/update/rewrite
 * result (`{ canvasId, version }` — `manage-canvas-tool.ts`). The UI package
 * does not depend on `@brainstrike/agent`, so the shape is narrowed
 * structurally, the same trade `run-python-result-model.ts` makes.
 *
 * Gated on the TOOL NAME as well as the shape: `{ canvasId, version }` is
 * generic enough that an MCP server could return it, and a chip that opened
 * the Canvas tab for a foreign id would be a lie. Both wire forms match —
 * the dotted id live, the Mastra-sanitized underscore form on a hydrated
 * thread — through `denormalizeNativeToolName`, like the edit-activity
 * stream does. Failures carry `ok: false` and never a chip; `list` carries
 * `canvases`, not `canvasId`.
 */
export interface CanvasMutationDisplayResult {
  readonly canvasId: string;
  readonly version: number;
}

export function readCanvasMutationResult(
  toolName: string,
  result: unknown
): CanvasMutationDisplayResult | null {
  if (denormalizeNativeToolName(toolName) !== NATIVE_TOOL_ID.manageCanvas) {
    return null;
  }
  if (typeof result !== 'object' || result === null || 'ok' in result) {
    return null;
  }
  const { canvasId, version } = result as { canvasId?: unknown; version?: unknown };
  if (typeof canvasId !== 'string' || !isLinkableCanvasId(canvasId)) {
    return null;
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return null;
  }
  return { canvasId, version };
}
