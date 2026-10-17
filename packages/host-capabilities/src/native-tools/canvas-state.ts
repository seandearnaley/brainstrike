import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
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

export const HostCanvasVersionSchema = Schema.Struct({
  canvasId: Schema.String.check(Schema.isMinCodePoints(1)),
  createdAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({}))),
  createdBy: Schema.Literals(['assistant', 'user']),
  html: Schema.String,
  title: Schema.String,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type HostCanvasVersion = (typeof HostCanvasVersionSchema)['Type'];

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
