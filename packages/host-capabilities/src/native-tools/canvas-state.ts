import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { z } from 'zod';

/**
 * A host thread's canvases as Core tool state: one `tool.state.updated` key per
 * canvas, whose committed values are its versions. Browser-safe, so clients
 * read the same record the host's canvas store writes.
 */
export const CANVAS_STATE_KEY_PREFIX = `${NATIVE_TOOL_ID.manageCanvas}/`;

export function canvasStateKey(canvasId: string): string {
  return `${CANVAS_STATE_KEY_PREFIX}${canvasId}`;
}

export const HostCanvasVersionSchema = z.strictObject({
  canvasId: z.string().min(1),
  createdAt: z.iso.datetime(),
  createdBy: z.enum(['assistant', 'user']),
  html: z.string(),
  title: z.string(),
  version: z.number().int().positive(),
});
export type HostCanvasVersion = z.infer<typeof HostCanvasVersionSchema>;

/** Every committed version of every canvas of a thread, oldest first per canvas. */
export function foldHostCanvases(
  rows: readonly HostLogRow[]
): ReadonlyMap<string, readonly HostCanvasVersion[]> {
  const canvases = new Map<string, HostCanvasVersion[]>();
  for (const row of rows) {
    const event = row.event;
    if (event.type !== 'tool.state.updated' || !event.key.startsWith(CANVAS_STATE_KEY_PREFIX)) {
      continue;
    }
    const version = HostCanvasVersionSchema.parse(event.value);
    if (canvasStateKey(version.canvasId) !== event.key) {
      throw new Error('A committed canvas version is stored under another canvas key');
    }
    const versions = canvases.get(version.canvasId) ?? [];
    versions.push(version);
    canvases.set(version.canvasId, versions);
  }
  return canvases;
}
