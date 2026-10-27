import {
  CANVAS_STATE_KEY_PREFIX,
  canvasStateKey,
  type HostCanvasVersion,
  HostCanvasVersionSchema,
  type HostLogRow,
} from '@brainstrike/agent-host/protocol';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';

/**
 * A host thread's canvases as Core tool state: one `tool.state.updated` key per
 * canvas, whose committed values are its versions. The record's shape and keys
 * are the host protocol's; this module folds a thread's log into it.
 */
export { CANVAS_STATE_KEY_PREFIX, canvasStateKey, type HostCanvasVersion, HostCanvasVersionSchema };

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
    const version = wireDecoder(HostCanvasVersionSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(event.value);
    if (canvasStateKey(version.canvasId) !== event.key) {
      throw new Error('A committed canvas version is stored under another canvas key');
    }
    const versions = canvases.get(version.canvasId) ?? [];
    versions.push(version);
    canvases.set(version.canvasId, versions);
  }
  return canvases;
}
