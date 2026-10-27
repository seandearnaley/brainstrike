import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { Schema } from 'effect';
import { z } from 'zod';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Timestamp = Schema.String.check(Schema.isPattern(z.regexes.datetime({})));

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
  canvasId: Id,
  createdAt: Timestamp,
  createdBy: Schema.Literals(['assistant', 'user']),
  html: Schema.String,
  title: Schema.String,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type HostCanvasVersion = (typeof HostCanvasVersionSchema)['Type'];

/**
 * One canvas at its latest committed version, as the Artifacts gallery lists
 * it: where it lives (its thread, and that thread's top-level root) without
 * its document.
 */
export const HostCanvasSummarySchema = Schema.Struct({
  canvasId: Id,
  createdBy: Schema.Literals(['assistant', 'user']),
  rootThreadId: Id,
  threadId: Id,
  title: Schema.String,
  updatedAt: Timestamp,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type HostCanvasSummary = (typeof HostCanvasSummarySchema)['Type'];

export const CANVAS_METHOD_SCHEMAS = {
  /** Every canvas of every thread the host owns, at its latest version, newest first. */
  'canvas/list': Schema.Record(Schema.String, Schema.Never),
  /** One canvas's latest committed version, document included; null when it does not exist. */
  'canvas/read': Schema.Struct({ canvasId: Id, threadId: Id }),
} as const;

export const CANVAS_RESULT_SCHEMAS = {
  'canvas/list': Schema.Struct({
    canvases: Schema.mutable(Schema.Array(HostCanvasSummarySchema)),
  }),
  'canvas/read': Schema.Struct({ canvas: Schema.NullOr(HostCanvasVersionSchema) }),
} as const;
