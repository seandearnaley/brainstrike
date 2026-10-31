import { BoundaryFailureSchema } from '@brainstrike/assistant-contract';
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Text = Schema.String;
const Dimension = Schema.Finite;

// --- terminals -------------------------------------------------------------

/** Terminals and command sessions answer in the one `BoundaryResult` envelope, failures typed. */
const BoundaryError = Schema.Struct({ error: BoundaryFailureSchema, ok: Schema.Literal(false) });
function boundaryResult<T extends Schema.Constraint>(value: T) {
  return Schema.Union([Schema.Struct({ ok: Schema.Literal(true), value }), BoundaryError], {
    mode: 'oneOf',
  });
}
const DoneSchema = boundaryResult(Schema.Null);
const TerminalCreatedSchema = boundaryResult(Schema.Struct({ cwd: Text, terminalId: Id }));

/** One terminal's output or exit, pushed only to the connection that created it. */
export const TERMINAL_EVENT = 'terminal/event';
export const TerminalEventSchema = Schema.Union(
  [
    Schema.Struct({ data: Text, terminalId: Id, type: Schema.Literal('data') }),
    Schema.Struct({
      exitCode: Schema.Int,
      signal: Schema.NullOr(Schema.Int),
      terminalId: Id,
      type: Schema.Literal('exit'),
    }),
  ],
  { mode: 'oneOf' }
);
export type TerminalEvent = (typeof TerminalEventSchema)['Type'];

// --- command sessions ------------------------------------------------------

const SessionIdentity = { rootId: Id, sessionId: Id };
const SessionBase = {
  createdAt: Schema.Finite,
  cwd: Text,
  id: Id,
  pid: Schema.Int,
  rootId: Id,
};
const CommandSessionInfoSchema = Schema.Union(
  [
    Schema.Struct({ ...SessionBase, status: Schema.Literal('running') }),
    Schema.Struct({
      ...SessionBase,
      exitCode: Schema.Int,
      exitedAt: Schema.Finite,
      signal: Schema.NullOr(Schema.Int),
      status: Schema.Literal('exited'),
    }),
  ],
  { mode: 'oneOf' }
);
/**
 * ADR-0029 stage 3: the Terminal panel's interactive terminals and the
 * inventory of the command sessions runs start, served by the host that owns
 * both. Only the desktop's private clients reach them.
 */
export const TERMINAL_METHOD_SCHEMAS = {
  'command-sessions/list': Schema.Struct({ rootId: Id }),
  'command-sessions/read': Schema.Struct({
    ...SessionIdentity,
    cursor: Schema.optionalKey(Schema.Finite),
  }),
  'command-sessions/remove': Schema.Struct(SessionIdentity),
  'command-sessions/stop': Schema.Struct(SessionIdentity),
  'command-sessions/write': Schema.Struct({ ...SessionIdentity, data: Text }),
  'terminal/create': Schema.Struct({
    cols: Schema.optionalKey(Dimension),
    cwd: Schema.optionalKey(Text),
    rootId: Id,
    rows: Schema.optionalKey(Dimension),
  }),
  'terminal/destroy': Schema.Struct({ terminalId: Id }),
  'terminal/resize': Schema.Struct({ cols: Dimension, rows: Dimension, terminalId: Id }),
  'terminal/write': Schema.Struct({ data: Text, terminalId: Id }),
} as const;

export const TERMINAL_RESULT_SCHEMAS = {
  'command-sessions/list': boundaryResult(
    Schema.Struct({ rootId: Id, sessions: Schema.Array(CommandSessionInfoSchema) })
  ),
  'command-sessions/read': boundaryResult(
    Schema.Struct({
      bufferStartCursor: Schema.Finite,
      hasMore: Schema.Boolean,
      nextCursor: Schema.Finite,
      output: Text,
      requestedCursor: Schema.Finite,
      session: CommandSessionInfoSchema,
      truncatedBeforeCursor: Schema.Boolean,
    })
  ),
  'command-sessions/remove': DoneSchema,
  'command-sessions/stop': DoneSchema,
  'command-sessions/write': DoneSchema,
  'terminal/create': TerminalCreatedSchema,
  'terminal/destroy': DoneSchema,
  'terminal/resize': DoneSchema,
  'terminal/write': DoneSchema,
} as const;
