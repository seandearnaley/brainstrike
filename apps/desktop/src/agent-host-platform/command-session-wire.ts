/**
 * Wire shapes of Main's Terminal panel reaching the desktop agent host's
 * command sessions (`host/command-sessions/*`): the same inventory bridge the
 * panel already speaks, served by the host's own session registry. Requests
 * are parsed by the host, results by Main. Imports nothing Main-only.
 */
import { z } from 'zod';

const Id = z.string().min(1);

const Identity = { rootId: Id, sessionId: Id };

export const HostCommandSessionListRequestSchema = z.strictObject({ rootId: Id });
export const HostCommandSessionReadRequestSchema = z.strictObject({
  ...Identity,
  cursor: z.number().exactOptional(),
});
export const HostCommandSessionWriteRequestSchema = z.strictObject({
  ...Identity,
  data: z.string(),
});
export const HostCommandSessionIdentitySchema = z.strictObject(Identity);

const SessionBase = {
  createdAt: z.number(),
  cwd: z.string(),
  id: Id,
  pid: z.number().int(),
  rootId: Id,
};

const CommandSessionInfoSchema = z.discriminatedUnion('status', [
  z.object({ ...SessionBase, status: z.literal('running') }),
  z.object({
    ...SessionBase,
    exitCode: z.number().int(),
    exitedAt: z.number(),
    signal: z.number().int().nullable(),
    status: z.literal('exited'),
  }),
]);

const Failure = z.object({
  error: z.object({
    code: z.enum([
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
    message: z.string(),
  }),
  ok: z.literal(false),
});

export const HostCommandSessionListResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.object({ rootId: Id, sessions: z.array(CommandSessionInfoSchema) }),
  }),
  Failure,
]);

export const HostCommandSessionReadResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.object({
      bufferStartCursor: z.number(),
      hasMore: z.boolean(),
      nextCursor: z.number(),
      output: z.string(),
      requestedCursor: z.number(),
      session: CommandSessionInfoSchema,
      truncatedBeforeCursor: z.boolean(),
    }),
  }),
  Failure,
]);

export const HostCommandSessionDoneResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  Failure,
]);

/** The host reaped and forgot this many sessions in a disconnected root. */
export const HostCommandSessionDisposeRootResultSchema = z.object({
  disposed: z.number().int().nonnegative(),
});
