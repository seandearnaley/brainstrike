import { McpTaskHandleSchema } from '@brainstrike/assistant-contract/mcp-task-presentation';
import { ThreadWorkspaceBindingSchema } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import { z } from 'zod';

// 11: committed branch history (`run/start` parentMessageId, `run/regenerate`,
// and the explicit branch links they commit on `run.started`), and thread
// titles (`thread/rename`, `thread.renamed`, titles in `thread/list`).
// 12: child threads (BST-1932): `thread.started` with a delegation `origin`.
export const AGENT_HOST_PROTOCOL_VERSION = 12;

// ADR-0017: transport request IDs never serve as durable command identities.
const Id = z.string().min(1);
const Command = { commandId: Id };
const Thread = { threadId: Id };
/** A committed thread title: trimmed, never blank. */
const ThreadTitle = z.string().trim().min(1);
const Run = { ...Thread, runId: Id };
const McpInput = { ...Run, interactionId: Id };
export const HostMcpInputStatusSchema = z.enum([
  'requested',
  'accepted',
  'local-finalized',
  'remote-acknowledged',
  'unknown',
  'retired',
]);
const McpContent = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
);
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
/**
 * BST-1932: a child thread's durable invocation identity, ancestry and owner.
 * The child threadId is the invocation ID; this origin commits in the same
 * transaction as the parent's delegation effect. `turnId` is the root run
 * whose user turn admitted the whole subtree.
 */
export const HostChildOriginSchema = z.strictObject({
  background: z.boolean(),
  depth: z.number().int().positive(),
  parentRunId: Id,
  parentThreadId: Id,
  persona: Id,
  toolCallId: Id,
  turnId: Id,
});
export type HostChildOrigin = z.infer<typeof HostChildOriginSchema>;
/** One settled background invocation delivered to its parent (BST-1932). */
export const HostChildDeliveryEntrySchema = z.strictObject({
  childRunId: Id,
  childThreadId: Id,
  /** What the parent's model reads in place of the dispatch acknowledgement. */
  outcome: z.string(),
  parentRunId: Id,
  state: z.enum(['returned', 'failed', 'cancelled']),
  toolCallId: Id,
});
export type HostChildDeliveryEntry = z.infer<typeof HostChildDeliveryEntrySchema>;
/**
 * The durable delivery watermark: these entries reached the parent's model
 * input on the run that records them, as an automated message that the user
 * did not write. A wake run's prompt is that message; a user turn carries it
 * ahead of its own message.
 */
export const HostChildDeliverySchema = z.discriminatedUnion('via', [
  z.strictObject({
    entries: z.array(HostChildDeliveryEntrySchema).min(1),
    messageId: Id,
    turnId: Id,
    via: z.literal('wake'),
  }),
  z.strictObject({
    entries: z.array(HostChildDeliveryEntrySchema).min(1),
    ledger: Id,
    messageId: Id,
    via: z.literal('next-turn'),
  }),
]);
export type HostChildDelivery = z.infer<typeof HostChildDeliverySchema>;
/** Credentials and executable capabilities remain process-local. */
export const HostRunSnapshotSchema = z.strictObject({
  configuration: z.record(z.string(), z.json()),
  maxSteps: z.number().int().positive(),
  mcpAuthorities: z.record(z.string(), McpToolAuthoritySchema).optional(),
  toolIdentities: z.record(z.string(), Id),
  workspaceBinding: ThreadWorkspaceBindingSchema.optional(),
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
  'mcp/input/read': z.strictObject(McpInput),
  'mcp/input/settle': z.strictObject({
    ...Command,
    ...McpInput,
    action: z.enum(['accept', 'decline', 'cancel']),
  }),
  // Values are process-local and never enter HostCommandLedger.
  'mcp/input/stage': z.strictObject({ ...McpInput, content: McpContent.optional() }),
  'run/regenerate': z.strictObject({
    ...Command,
    ...Thread,
    configuration: z.record(z.string(), z.json()).optional(),
    modelId: Id,
    /** The original committed user message: its run/start command ID. */
    userMessageId: Id,
  }),
  'run/start': z.strictObject({
    ...Command,
    ...Thread,
    configuration: z.record(z.string(), z.json()).optional(),
    modelId: Id,
    /** A committed run ID to follow, null for the thread root; omitted is the current tip. */
    parentMessageId: Id.nullable().optional(),
    prompt: Id,
  }),
  'run/stop': z.strictObject({ ...Command, ...Run }),
  /** Destructive Root lifecycle; the existing StateStore intent owns recovery. */
  'thread/delete': z.strictObject(Thread),
  'thread/list': z.strictObject({}),
  'thread/read': z.strictObject({ ...Thread, fromSeq: Seq }),
  'thread/rename': z.strictObject({ ...Command, ...Thread, title: ThreadTitle }),
  'thread/start': z.strictObject(Command),
  'thread/workspace/binding/read': z.strictObject(Thread),
  'thread/workspace/binding/update': z.strictObject({
    ...Command,
    ...Thread,
    patch: ThreadWorkspaceBindingSchema,
  }),
  'thread/workspace/read': z.strictObject(Thread),
  'thread/workspace/set': z.strictObject({
    ...Command,
    ...Thread,
    snapshot: WorkspaceSnapshotSchema,
  }),
} as const;
export type HostMethod = keyof typeof HOST_METHOD_SCHEMAS;
export type HostParams<M extends HostMethod> = z.infer<(typeof HOST_METHOD_SCHEMAS)[M]>;
/** Private input diagnostics must not quote schema paths or unknown secret-bearing keys. */
export function parseHostParams<M extends HostMethod>(method: M, input: unknown): HostParams<M> {
  if (!method.startsWith('mcp/')) {
    return HOST_METHOD_SCHEMAS[method].parse(input) as HostParams<M>;
  }
  const parsed = HOST_METHOD_SCHEMAS[method].safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid MCP host request');
  }
  return parsed.data as HostParams<M>;
}

const RunFields = { runId: Id };
const Action = {
  ...RunFields,
  input: z.json(),
  toolCallId: Id,
  toolId: Id,
  toolIdentity: Id,
};
const McpOrigin = {
  ...RunFields,
  configuredServerId: Id,
  generation: z.number().int().positive().safe(),
  toolCallId: Id,
  toolId: Id,
  toolIdentity: Id,
};
export const HostMcpInputRequestSchema = z.strictObject({
  ...McpOrigin,
  interactionId: Id,
  invocationId: Id,
  mode: z.enum(['form', 'url']),
  requestId: z.union([Id, z.number().int().safe()]),
  taskId: Id.optional(),
  type: z.literal('mcp.input.requested'),
});
export const HostEventSchema = z.union([
  z.strictObject({
    binding: ThreadWorkspaceBindingSchema,
    type: z.literal('workspace.binding.updated'),
  }),
  z.strictObject({ ...McpOrigin, handle: McpTaskHandleSchema, type: z.literal('mcp.task.bound') }),
  HostMcpInputRequestSchema,
  z.strictObject({
    ...RunFields,
    action: z.enum(['accept', 'decline', 'cancel']),
    commandId: Id,
    interactionId: Id,
    type: z.literal('mcp.input.intent'),
  }),
  z.strictObject({
    ...RunFields,
    interactionId: Id,
    status: z.enum(['local-finalized', 'remote-acknowledged', 'unknown', 'retired']),
    type: z.literal('mcp.input.settled'),
  }),
  z.strictObject({ commandId: Id, type: z.literal('thread.started') }),
  z.strictObject({ origin: HostChildOriginSchema, type: z.literal('thread.started') }),
  z.strictObject({ title: ThreadTitle, type: z.literal('thread.renamed') }),
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
    /** BST-1932: background child results this run delivers to its model. */
    delivery: HostChildDeliverySchema.optional(),
    modelId: Id,
    /**
     * The committed message this run's new user message follows (a run ID;
     * null is the thread root). Rows committed before branch history omit
     * it: their parent is the previous run.
     */
    parentMessageId: Id.nullable().optional(),
    parentRunId: Id.optional(),
    prompt: Id,
    snapshot: HostRunSnapshotSchema.optional(),
    /** Regenerate only: the existing committed user message this run answers again. */
    userMessageId: Id.optional(),
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
  'mcp/input/read': z.strictObject({
    // Only a current private capability can supply this ephemeral presentation.
    presentation: z.json().optional(),
    request: HostMcpInputRequestSchema,
    status: HostMcpInputStatusSchema,
  }),
  'mcp/input/settle': z.strictObject({
    accepted: z.literal(true),
    status: HostMcpInputStatusSchema,
  }),
  'mcp/input/stage': z.strictObject({ staged: z.literal(true) }),
  'run/regenerate': z.strictObject({ runId: Id }),
  'run/start': z.strictObject({ runId: Id }),
  'run/stop': z.strictObject({ outcome: z.enum(['stopped', 'already-terminal']) }),
  'thread/delete': z.strictObject({ deleted: z.literal(true) }),
  'thread/list': z.strictObject({
    // A thread never renamed has no committed title.
    threads: z.array(z.strictObject({ ...Thread, title: ThreadTitle.optional() })),
  }),
  'thread/read': z.strictObject({ rows: z.array(HostLogRowSchema) }),
  'thread/rename': z.strictObject({ accepted: z.literal(true) }),
  'thread/start': z.strictObject(Thread),
  'thread/workspace/binding/read': z.strictObject({
    binding: ThreadWorkspaceBindingSchema.nullable(),
  }),
  'thread/workspace/binding/update': z.strictObject({ accepted: z.literal(true) }),
  'thread/workspace/read': z.strictObject({ snapshot: WorkspaceSnapshotSchema.nullable() }),
  'thread/workspace/set': z.strictObject({ accepted: z.literal(true) }),
} as const;
export type HostResults = { [M in HostMethod]: z.infer<(typeof HOST_RESULT_SCHEMAS)[M]> };
