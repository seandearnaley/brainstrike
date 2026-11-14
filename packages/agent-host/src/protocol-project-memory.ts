/**
 * ADR-0040: project memory's committed events and Undo. A write the memory
 * tool made is a `memory.changed` the thread shows as a card; a note refused
 * before it was stored is a `memory.refused`; Undo is `memory/undo`.
 */
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
/** A path under `/memories`, as the memory tool names a note. */
const MemoryPath = Schema.String.check(Schema.isPattern(/^\/memories(?:\/|$)/u));
const MemoryCall = { runId: Id, toolCallId: Id };

/** One write of a project's memory, without its run and call. */
export const HostMemoryChangeSchema = Schema.Struct({
  /** A rename's source; absent for every other write. */
  fromPath: Schema.optional(MemoryPath),
  path: MemoryPath,
  /** The note before the write; null when there was none. */
  previous: Schema.NullOr(Schema.String),
  projectId: Id,
  /** The note after the write; null once it is deleted. */
  text: Schema.NullOr(Schema.String),
  title: Id,
  /** Saved by a run that read web or MCP tool output; the note keeps the mark. */
  untrusted: Schema.Boolean,
});
export type HostMemoryChange = (typeof HostMemoryChangeSchema)['Type'];

/** A note the host refused to store, with why; the note's text is never committed. */
export const HostMemoryRefusalSchema = Schema.Struct({
  path: MemoryPath,
  projectId: Id,
  reason: Id,
  title: Id,
});
export type HostMemoryRefusal = (typeof HostMemoryRefusalSchema)['Type'];

export const PROJECT_MEMORY_EVENT_SCHEMAS = [
  Schema.Struct({
    ...MemoryCall,
    ...HostMemoryChangeSchema.fields,
    type: Schema.Literal('memory.changed'),
  }),
  Schema.Struct({
    ...MemoryCall,
    ...HostMemoryRefusalSchema.fields,
    type: Schema.Literal('memory.refused'),
  }),
  /** Undo restored what the call's write replaced. */
  Schema.Struct({
    ...MemoryCall,
    commandId: Id,
    type: Schema.Literal('memory.undone'),
  }),
] as const;

export const PROJECT_MEMORY_METHOD_SCHEMAS = {
  /**
   * Restore what one memory write replaced: delete the note it created, put back
   * the text it changed, or move a renamed note back. Refused once the note has
   * changed since, and for a write already undone.
   */
  'memory/undo': Schema.Struct({ commandId: Id, runId: Id, threadId: Id, toolCallId: Id }),
} as const;

export const PROJECT_MEMORY_RESULT_SCHEMAS = {
  'memory/undo': Schema.Struct({ undone: Schema.Literal(true) }),
} as const;
