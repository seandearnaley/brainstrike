import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import { z } from 'zod';

export const AGENT_HOST_PROTOCOL_VERSION = 8;

// ADR-0017: transport request IDs never serve as durable command identities.
const Id = z.string().min(1);
const Command = { commandId: Id };
const Thread = { threadId: Id };
const Run = { ...Thread, runId: Id };
const Seq = z.number().int().nonnegative();
const McpAuthorityBase = {
  extensions: z.strictObject({ apps: z.boolean(), tasks: z.boolean() }),
  protocol: z.enum(['legacy', 'auto', '2026-07-28']),
  version: z.literal(1),
};
/** Supplied by the configured-server owner; private values have no durable surrogate. */
export const McpToolAuthoritySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...McpAuthorityBase,
    auth: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('none') }),
      z.strictObject({
        credential: z.strictObject({ id: z.uuid(), store: z.literal('mcp-credentials') }),
        principalComparison: z.literal('unavailable'),
        type: z.literal('bearer'),
      }),
    ]),
    destination: z.url(),
    kind: z.literal('http'),
    transport: z.enum(['streamable-http', 'sse']),
  }),
  z.strictObject({
    ...McpAuthorityBase,
    args: z.tuple([]),
    command: Id,
    cwd: Id,
    kind: z.literal('stdio'),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.enum([
      'private-stdio-arguments',
      'private-stdio-environment',
      'unresolved-stdio-command',
      'private-http-headers',
      'private-http-destination',
      'oauth-principal-not-comparable',
    ]),
    version: z.literal(1),
  }),
]);
export type McpToolAuthority = z.infer<typeof McpToolAuthoritySchema>;
/** Credentials and executable capabilities remain process-local. */
export const HostRunSnapshotSchema = z.strictObject({
  configuration: z.record(z.string(), z.json()),
  maxSteps: z.number().int().positive(),
  mcpAuthorities: z.record(z.string(), McpToolAuthoritySchema).optional(),
  toolIdentities: z.record(z.string(), Id),
});
export type HostRunSnapshot = z.infer<typeof HostRunSnapshotSchema>;
export const HOST_METHOD_SCHEMAS = {
  'host/stop': z.strictObject({}),
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
  'interaction/resume': z.strictObject({
    ...Command,
    ...Run,
    interactionId: Id,
    resumeData: z.json(),
  }),
  'log/subscribe': z.strictObject({ ...Thread, fromSeq: Seq }),
  'log/unsubscribe': z.strictObject(Thread),
  'run/start': z.strictObject({
    ...Command,
    ...Thread,
    configuration: z.record(z.string(), z.json()).optional(),
    modelId: Id,
    prompt: Id,
  }),
  'run/stop': z.strictObject({ ...Command, ...Run }),
  /** Destructive Root lifecycle; the existing StateStore intent owns recovery. */
  'thread/delete': z.strictObject(Thread),
  'thread/list': z.strictObject({}),
  'thread/read': z.strictObject({ ...Thread, fromSeq: Seq }),
  'thread/start': z.strictObject(Command),
  'thread/workspace/read': z.strictObject(Thread),
  'thread/workspace/set': z.strictObject({
    ...Command,
    ...Thread,
    snapshot: WorkspaceSnapshotSchema,
  }),
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
export const HostEventSchema = z.union([
  z.strictObject({ commandId: Id, type: z.literal('thread.started') }),
  z.strictObject({ snapshot: WorkspaceSnapshotSchema, type: z.literal('workspace.updated') }),
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
    snapshot: HostRunSnapshotSchema.optional(),
  }),
  z.strictObject({ type: z.literal('stream.chunk'), ...RunFields, chunk: z.json() }),
  z.strictObject({
    type: z.literal('model.step'),
    ...RunFields,
    messages: z.array(z.json()),
    model: z.json(),
    stepNumber: Seq,
    usage: z.json(),
  }),
  z.strictObject({ type: z.literal('model.messages'), ...RunFields, messages: z.array(z.json()) }),
  z.strictObject({
    type: z.literal('memory.usage'),
    ...RunFields,
    kind: z.enum(['observation', 'reflection']),
    modelId: Id,
    usage: z.json(),
  }),
  z.strictObject({
    type: z.literal('provider.request.prepared'),
    ...RunFields,
    accounting: z.json(),
    modelId: Id,
    provider: Id,
  }),
  z.strictObject({
    type: z.literal('interaction.requested'),
    ...Action,
    interactionId: Id,
    kind: z.enum(['approval', 'question', 'plan']),
  }),
  z.strictObject({
    type: z.literal('interaction.responded'),
    ...RunFields,
    decision: z.enum(['approve', 'deny']),
    interactionId: Id,
  }),
  z.strictObject({
    type: z.literal('interaction.responded'),
    ...RunFields,
    interactionId: Id,
    resumeData: z.json(),
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
  /** Existing run_events.created_at, including live publication and replay. */
  ts: z.number().int().nonnegative().optional(),
});
export type HostLogRow = z.infer<typeof HostLogRowSchema>;
export const HOST_RESULT_SCHEMAS = {
  'host/stop': z.strictObject({ outcome: z.literal('stopped'), rootReleased: z.literal(true) }),
  initialize: z.strictObject({
    hostVersion: Id,
    pid: z.number().int().positive(),
    protocolVersion: z.number().int().positive(),
    start: Id,
  }),
  'interaction/respond': z.strictObject({ accepted: z.literal(true) }),
  'interaction/resume': z.strictObject({ accepted: z.literal(true) }),
  'log/subscribe': z.strictObject({ rows: z.array(HostLogRowSchema) }),
  'log/unsubscribe': z.strictObject({ unsubscribed: z.literal(true) }),
  'run/start': z.strictObject({ runId: Id }),
  'run/stop': z.strictObject({ outcome: z.enum(['stopped', 'already-terminal']) }),
  'thread/delete': z.strictObject({ deleted: z.literal(true) }),
  'thread/list': z.strictObject({ threads: z.array(z.strictObject(Thread)) }),
  'thread/read': z.strictObject({ rows: z.array(HostLogRowSchema) }),
  'thread/start': z.strictObject(Thread),
  'thread/workspace/read': z.strictObject({ snapshot: WorkspaceSnapshotSchema.nullable() }),
  'thread/workspace/set': z.strictObject({ accepted: z.literal(true) }),
} as const;
export type HostResults = { [M in HostMethod]: z.infer<(typeof HOST_RESULT_SCHEMAS)[M]> };
