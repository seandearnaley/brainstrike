import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));

const Identity = { rootId: Id, sessionId: Id };

export const HostCommandSessionListRequestSchema = Schema.Struct({ rootId: Id });
export const HostCommandSessionReadRequestSchema = Schema.Struct({
  ...Identity,
  cursor: Schema.optionalKey(Schema.Finite),
});
export const HostCommandSessionWriteRequestSchema = Schema.Struct({
  ...Identity,
  data: Schema.String,
});
export const HostCommandSessionIdentitySchema = Schema.Struct(Identity);

const SessionBase = {
  createdAt: Schema.Finite,
  cwd: Schema.String,
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

const Failure = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals([
      'aborted',
      'cursor-out-of-range',
      'cwd-not-found',
      'cwd-outside-root',
      'internal',
      'invalid-buffer',
      'invalid-input',
      'root-unavailable',
      'session-exited',
      'session-id-collision',
      'session-not-found',
      'start-failed',
      'stop-failed',
      'workspace-busy',
    ]),
    message: Schema.String,
  }),
  ok: Schema.Literal(false),
});

export const HostCommandSessionListResultSchema = Schema.Union(
  [
    Schema.Struct({
      ok: Schema.Literal(true),
      value: Schema.Struct({
        rootId: Id,
        sessions: Schema.mutable(Schema.Array(CommandSessionInfoSchema)),
      }),
    }),
    Failure,
  ],
  { mode: 'oneOf' }
);

export const HostCommandSessionReadResultSchema = Schema.Union(
  [
    Schema.Struct({
      ok: Schema.Literal(true),
      value: Schema.Struct({
        bufferStartCursor: Schema.Finite,
        hasMore: Schema.Boolean,
        nextCursor: Schema.Finite,
        output: Schema.String,
        requestedCursor: Schema.Finite,
        session: CommandSessionInfoSchema,
        truncatedBeforeCursor: Schema.Boolean,
      }),
    }),
    Failure,
  ],
  { mode: 'oneOf' }
);

export const HostCommandSessionDoneResultSchema = Schema.Union(
  [Schema.Struct({ ok: Schema.Literal(true) }), Failure],
  { mode: 'oneOf' }
);

/** The host reaped and forgot this many sessions in a disconnected root. */
export const HostCommandSessionDisposeRootResultSchema = Schema.Struct({
  disposed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
