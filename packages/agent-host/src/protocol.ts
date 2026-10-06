import { z } from 'zod';

export const AGENT_HOST_PROTOCOL_VERSION = 2;

// ADR-0017: transport request IDs never serve as durable command identities.
const Id = z.string().min(1);
const Command = { commandId: Id };
const Thread = { threadId: Id };
const Run = { ...Thread, runId: Id };
const Seq = z.number().int().nonnegative();
export const HOST_METHOD_SCHEMAS = {
  initialize: z.strictObject({
    hostVersion: Id,
    protocolVersion: z.number().int().positive(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  'interaction/respond': z.strictObject({
    ...Command,
    ...Run,
    decision: z.enum(['approve', 'deny']),
    interactionId: Id,
  }),
  'log/subscribe': z.strictObject({ ...Thread, fromSeq: Seq }),
  'log/unsubscribe': z.strictObject(Thread),
  'run/start': z.strictObject({ ...Command, ...Thread, modelId: Id, prompt: Id }),
  'run/stop': z.strictObject({ ...Command, ...Run }),
  'thread/read': z.strictObject({ ...Thread, fromSeq: Seq }),
  'thread/start': z.strictObject(Command),
} as const;
export type HostMethod = keyof typeof HOST_METHOD_SCHEMAS;
export type HostParams<M extends HostMethod> = z.infer<(typeof HOST_METHOD_SCHEMAS)[M]>;

const RunFields = { runId: Id };
const Action = {
  ...RunFields,
  input: z.json(),
  toolCallId: Id,
  toolId: Id,
  toolIdentity: Id,
};
export const HostEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ commandId: Id, type: z.literal('thread.started') }),
  z.strictObject({
    commandId: Id,
    method: Id,
    payload: z.json(),
    result: z.json(),
    type: z.literal('command.accepted'),
  }),
  z.strictObject({
    type: z.literal('run.started'),
    ...RunFields,
    modelId: Id,
    parentRunId: Id.optional(),
    prompt: Id,
  }),
  z.strictObject({ type: z.literal('stream.chunk'), ...RunFields, chunk: z.json() }),
  z.strictObject({
    type: z.literal('interaction.requested'),
    ...Action,
    interactionId: Id,
    kind: z.literal('approval'),
  }),
  z.strictObject({
    type: z.literal('interaction.responded'),
    ...RunFields,
    decision: z.enum(['approve', 'deny']),
    interactionId: Id,
  }),
  z.strictObject({ type: z.literal('effect.started'), ...Action }),
  z.strictObject({
    type: z.literal('effect.finished'),
    ...RunFields,
    output: z.json(),
    toolCallId: Id,
  }),
  z.strictObject({
    type: z.literal('run.finished'),
    ...RunFields,
    detail: z.string().optional(),
    outcome: z.enum(['completed', 'failed', 'stopped', 'interrupted']),
  }),
]);
export type HostEvent = z.infer<typeof HostEventSchema>;
export const HostLogRowSchema = z.strictObject({
  event: HostEventSchema,
  seq: z.number().int().positive(),
  threadId: Id,
});
export type HostLogRow = z.infer<typeof HostLogRowSchema>;
export const HOST_RESULT_SCHEMAS = {
  initialize: z.strictObject({
    hostVersion: Id,
    pid: z.number().int().positive(),
    protocolVersion: z.number().int().positive(),
    start: Id,
  }),
  'interaction/respond': z.strictObject({ accepted: z.literal(true) }),
  'log/subscribe': z.strictObject({ rows: z.array(HostLogRowSchema) }),
  'log/unsubscribe': z.strictObject({ unsubscribed: z.literal(true) }),
  'run/start': z.strictObject({ runId: Id }),
  'run/stop': z.strictObject({ outcome: z.enum(['stopped', 'already-terminal']) }),
  'thread/read': z.strictObject({ rows: z.array(HostLogRowSchema) }),
  'thread/start': z.strictObject(Thread),
} as const;
export type HostResults = { [M in HostMethod]: z.infer<(typeof HOST_RESULT_SCHEMAS)[M]> };
