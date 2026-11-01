import {
  isProviderCredential,
  McpAppOriginSchema,
  type OpenRouterModelMetadataSnapshot,
  type ProviderCredential,
  type ProviderVerificationSnapshot,
  parseOpenRouterModelMetadataSnapshot,
  parseProviderVerificationSnapshot,
  ReferencedFileFailureSchema,
  TOOL_RISK_CATEGORIES,
} from '@brainstrike/assistant-contract';
import { ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE } from '@brainstrike/assistant-contract/assistant-attachments';
import { McpTaskHandleSchema } from '@brainstrike/assistant-contract/mcp-task-presentation';
import {
  opaqueWireSchema,
  wireDecoder,
  wireResultDecoder,
} from '@brainstrike/assistant-contract/schema-boundary';
import { ThreadWorkspaceBindingSchema } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import { Schema } from 'effect';
import type { JsonSchemaFactory } from './json-value.ts';
import { HostLatestRunSchema, HostLedgerThreadSchema } from './ledger-wire.ts';
import { McpToolAuthoritySchema } from './mcp-authority-wire.ts';
import { HOST_APPROVAL_FACT_FIELDS } from './protocol-approval-facts.ts';
import { CANVAS_METHOD_SCHEMAS, CANVAS_RESULT_SCHEMAS } from './protocol-canvas.ts';
import {
  GIT_WORKSPACE_METHOD_SCHEMAS,
  GIT_WORKSPACE_RESULT_SCHEMAS,
} from './protocol-git-workspace.ts';
import { HOOK_TRUST_METHOD_SCHEMAS, HOOK_TRUST_RESULT_SCHEMAS } from './protocol-hook-trust.ts';
import { MCP_CONTENT_METHOD_SCHEMAS, MCP_CONTENT_RESULT_SCHEMAS } from './protocol-mcp-content.ts';
import {
  MCP_PRESENTATION_METHOD_SCHEMAS,
  MCP_PRESENTATION_RESULT_SCHEMAS,
} from './protocol-mcp-presentation.ts';
import {
  MCP_SETTINGS_METHOD_SCHEMAS,
  MCP_SETTINGS_RESULT_SCHEMAS,
} from './protocol-mcp-settings.ts';
import {
  HostMemoryCycleEventSchema,
  HostMemoryEmbedderProbeParamsSchema,
  HostMemoryEmbedderProbeResultSchema,
  HostMemoryModelsSchema,
  HostObservationalMemoryStateSchema,
} from './protocol-memory.ts';
import {
  HostBrowserOriginSchema,
  PERMISSION_POLICY_METHOD_SCHEMAS,
  PERMISSION_POLICY_RESULT_SCHEMAS,
} from './protocol-permission-policy.ts';
import {
  REWIND_EVENT_SCHEMAS,
  REWIND_METHOD_SCHEMAS,
  REWIND_RESULT_SCHEMAS,
} from './protocol-rewind.ts';
import { SEARCH_METHOD_SCHEMAS, SEARCH_RESULT_SCHEMAS } from './protocol-search.ts';
import {
  SELECTION_METHOD_SCHEMAS,
  SELECTION_RESULT_SCHEMAS,
  selectionEventSchemas,
} from './protocol-selection.ts';
import { HostStateHealthSchema } from './protocol-state-health.ts';
import { TERMINAL_METHOD_SCHEMAS, TERMINAL_RESULT_SCHEMAS } from './protocol-terminals.ts';
import {
  THREAD_WORKSPACE_METHOD_SCHEMAS,
  THREAD_WORKSPACE_RESULT_SCHEMAS,
} from './protocol-thread-workspace.ts';
import {
  WORKSPACE_DISCOVERY_METHOD_SCHEMAS,
  WORKSPACE_DISCOVERY_RESULT_SCHEMAS,
} from './protocol-workspace-discovery.ts';
import {
  WORKSPACE_FILES_METHOD_SCHEMAS,
  WORKSPACE_FILES_RESULT_SCHEMAS,
} from './protocol-workspace-files.ts';
import {
  WORKSPACE_ROOTS_METHOD_SCHEMAS,
  WORKSPACE_ROOTS_RESULT_SCHEMAS,
} from './protocol-workspace-roots.ts';
import {
  RunVerdictDetailSchema,
  RunVerdictSchema,
  RunVerdictSourceSchema,
} from './run-verdict-wire.ts';
import { HostHookSkipSchema, HostImageAttachmentSchema } from './run-wire.ts';
import {
  HostEditBaselineSchema,
  HostEditRevertOutcomeSchema,
  HostFileIdentitySchema,
  HostTurnSnapshotSchema,
  HostWorkspaceEditOpSchema,
  Sha256,
  WorkspaceRelativePath,
} from './workspace-wire.ts';

export * from './mcp-authority-wire.ts';
export * from './protocol-canvas.ts';
export * from './protocol-git-workspace.ts';
export * from './protocol-hook-trust.ts';
export * from './protocol-mcp-content.ts';
export * from './protocol-mcp-presentation.ts';
export * from './protocol-mcp-settings.ts';
export * from './protocol-memory.ts';
export * from './protocol-permission-policy.ts';
export * from './protocol-rewind.ts';
export * from './protocol-search.ts';
export * from './protocol-selection.ts';
export * from './protocol-state-health.ts';
export * from './protocol-terminals.ts';
export * from './protocol-thread-workspace.ts';
export * from './protocol-version.ts';
export * from './protocol-workspace-discovery.ts';
export * from './protocol-workspace-files.ts';
export * from './protocol-workspace-roots.ts';
export * from './run-wire.ts';
export * from './workspace-wire.ts';

// ADR-0017: transport request IDs never serve as durable command identities.
const Id = Schema.String.check(Schema.isMinCodePoints(1));
/**
 * A user message's text: empty only beside its images (an image sent alone,
 * as the composer allows), never a message of nothing.
 */
const Prompt = Schema.String;
const hasMessage = (message: {
  readonly attachments?: readonly unknown[] | undefined;
  readonly prompt: string;
}): boolean => message.prompt.length > 0 || (message.attachments?.length ?? 0) > 0;
const NO_MESSAGE = { message: 'A message needs text or an image', path: ['prompt'] };
const Command = { commandId: Id };
const Thread = { threadId: Id };
/** A time the state store recorded, in ms since the epoch. */
const StoredTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** A committed thread title: trimmed, never blank. */
const ThreadTitle = Schema.String.pipe(Schema.decodeTo(Schema.Trim)).check(
  Schema.isMinCodePoints(1)
);
/** A thread's committed presentation; each field is optional and set independently. */
const ThreadPresentation = {
  color: Schema.optional(Id),
  icon: Schema.optional(Id),
  title: Schema.optional(ThreadTitle),
};
const Run = { ...Thread, runId: Id };
/**
 * Plan mode: the run may only read and propose a plan. Approving its plan ends
 * it and starts the thread's next run without plan mode.
 */
const PlanMode = { planMode: Schema.optional(Schema.Literal(true)) };
const RiskCategory = Schema.Literals(TOOL_RISK_CATEGORIES);
/**
 * BST-1990 (D4): the JSON-RPC error code of a run command the host refused
 * before it admitted the run. Nothing was committed, so a client may hand the
 * user's message back for a resend; any other failure may follow acceptance.
 */
export const HOST_RUN_NOT_ADMITTED_CODE = -32_010;
export {
  type HostApprovalTargetRoot,
  HostApprovalTargetRootSchema,
} from './protocol-approval-facts.ts';

/**
 * A grant answered with an approval: the rest of that run allows the call's
 * risk category (`session`; the client keeps it for its later runs) or the
 * call's tool. Core accepts only the approved call's own category or tool.
 */
const PermissionGrant = Schema.Union(
  [
    Schema.Struct({ category: RiskCategory, scope: Schema.Literal('session') }),
    Schema.Struct({ scope: Schema.Literal('tool'), toolId: Id }),
  ],
  { mode: 'oneOf' }
);
export type HostPermissionGrant = (typeof PermissionGrant)['Type'];
const McpInput = { ...Run, interactionId: Id };
/** An MCP App's own tool call: the app a committed tool result of the thread mounted. */
const McpAppCall = {
  ...Thread,
  app: McpAppOriginSchema,
  arguments: Schema.Record(Schema.String, Schema.MutableJson),
  toolName: Id,
};
export const HostMcpInputStatusSchema = Schema.Literals([
  'requested',
  'accepted',
  'local-finalized',
  'remote-acknowledged',
  'unknown',
  'retired',
]);
const McpContent = Schema.Record(
  Schema.String,
  Schema.Union([
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.mutable(Schema.Array(Schema.String)),
  ])
);
const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Attachments = Schema.mutable(Schema.Array(HostImageAttachmentSchema))
  .check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE));
/**
 * BST-1932: a child thread's durable invocation identity, ancestry and owner.
 * The child threadId is the invocation ID; this origin commits in the same
 * transaction as the parent's delegation effect. `turnId` is the root run
 * whose user turn admitted the whole subtree.
 */
export const HostChildOriginSchema = Schema.Struct({
  background: Schema.Boolean,
  depth: Schema.Int.check(Schema.isGreaterThan(0)),
  parentRunId: Id,
  parentThreadId: Id,
  persona: Id,
  profile: Schema.optional(
    Schema.Struct({
      label: Schema.String.check(Schema.isMinCodePoints(1)),
      mode: Schema.Literals(['read-only', 'worker']),
    })
  ),
  toolCallId: Id,
  turnId: Id,
});
export type HostChildOrigin = (typeof HostChildOriginSchema)['Type'];
/**
 * BST-1932: a child as its parent's sidebar shows it: a run in progress, a run
 * waiting on a person's answer, or no run in progress.
 */
export const HostChildStatusSchema = Schema.Literals(['working', 'needs-input', 'idle']);
export type HostChildStatus = (typeof HostChildStatusSchema)['Type'];
/**
 * The host's announcement, on each connection, that it is retiring (as HTTP/2's
 * GOAWAY). The host sends it first, then refuses new requests as `host.closing`
 * and answers every request it read. Its client refuses later sends unsent.
 */
export const HOST_CLOSING_EVENT = 'host/closing';
/**
 * The retiring host's last frame before it closes the transport (as TLS's
 * close_notify): every request it read on this connection is answered above it.
 * So a request still unanswered at the close was never read, and its client
 * refuses it as `host.closing`. Without this frame, as when the host crashes
 * mid-retirement, an unanswered request may have run: it stays a lost connection.
 */
export const HOST_DRAINED_EVENT = 'host/drained';
/**
 * BST-1932: the host's notice that a thread's children changed status (a child
 * run started, paused for a person, was answered or ended). A client re-reads
 * `thread/children` for `threadId` only when told.
 */
export const HOST_CHILDREN_CHANGED = 'thread/children/changed';
export const HostChildrenChangedSchema = Schema.Struct(Thread);
/**
 * A run's live telemetry, sent to the thread's log subscribers and never
 * committed (ADR-0011 amendment): a tool's shell-output slice or MCP progress,
 * which names its `toolCallId`, or the model's text and reasoning stream,
 * which names none. The committed tool result and `model.step` messages own
 * that content; a reload shows them and no telemetry.
 *
 * Each stream's chunks are numbered by `ordinal`, from 0: a tool call's, or a
 * run's text and reasoning. A `log/subscribe` result replays the thread's
 * running calls and open steps, so a view that opens mid-call shows what it
 * missed and skips any ordinal it already applied.
 */
export const HOST_RUN_TELEMETRY = 'run/telemetry';
export const HostRunTelemetrySchema = Schema.Struct({
  ...Thread,
  chunk: Schema.MutableJson,
  ordinal: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  runId: Id,
  toolCallId: Schema.optional(Id),
});
export type HostRunTelemetry = (typeof HostRunTelemetrySchema)['Type'];
/** One settled background invocation delivered to its parent (BST-1932). */
export const HostChildDeliveryEntrySchema = Schema.Struct({
  childRunId: Id,
  childThreadId: Id,
  followUp: Schema.optional(Schema.Literal(true)),
  outcome: Schema.String,
  parentRunId: Id,
  state: Schema.Literals(['returned', 'failed', 'cancelled']),
  toolCallId: Id,
});
export type HostChildDeliveryEntry = (typeof HostChildDeliveryEntrySchema)['Type'];
/**
 * The durable delivery watermark: these entries reached the parent's model
 * input on the run that records them, as an automated message that the user
 * did not write. A wake run's prompt is that message; a user turn carries it
 * ahead of its own message.
 */
export const HostChildDeliverySchema = Schema.Union(
  [
    Schema.Struct({
      entries: Schema.mutable(Schema.Array(HostChildDeliveryEntrySchema)).check(
        Schema.isMinLength(1)
      ),
      messageId: Id,
      turnId: Id,
      via: Schema.Literal('wake'),
    }),
    Schema.Struct({
      entries: Schema.mutable(Schema.Array(HostChildDeliveryEntrySchema)).check(
        Schema.isMinLength(1)
      ),
      ledger: Id,
      messageId: Id,
      via: Schema.Literal('next-turn'),
    }),
  ],
  { mode: 'oneOf' }
);
export type HostChildDelivery = (typeof HostChildDeliverySchema)['Type'];
/** Credentials and executable capabilities remain process-local. */
export function hostRunSnapshotSchema(json: JsonSchemaFactory) {
  return Schema.Struct({
    configuration: Schema.Record(Schema.String, json()),
    maxSteps: Schema.Int.check(Schema.isGreaterThan(0)),
    mcpAuthorities: Schema.optional(Schema.Record(Schema.String, McpToolAuthoritySchema)),
    toolIdentities: Schema.Record(Schema.String, Id),
    workspaceBinding: Schema.optional(ThreadWorkspaceBindingSchema),
  });
}
export const HostRunSnapshotSchema = hostRunSnapshotSchema(() => Schema.MutableJson);
export type HostRunSnapshot = (typeof HostRunSnapshotSchema)['Type'];
const LoginCredential = Schema.declare<ProviderCredential>(isProviderCredential);
const Provider = { provider: Id };
export const HOST_METHOD_SCHEMAS = {
  ...CANVAS_METHOD_SCHEMAS,
  ...GIT_WORKSPACE_METHOD_SCHEMAS,
  ...HOOK_TRUST_METHOD_SCHEMAS,
  ...MCP_CONTENT_METHOD_SCHEMAS,
  ...MCP_PRESENTATION_METHOD_SCHEMAS,
  ...MCP_SETTINGS_METHOD_SCHEMAS,
  ...PERMISSION_POLICY_METHOD_SCHEMAS,
  ...TERMINAL_METHOD_SCHEMAS,
  // auth/* is secret-bearing: process-local, never in HostCommandLedger, the log
  // or diagnostics. The host is the single writer and token holder.
  'auth/credential/delete': Schema.Struct({ account: Id }),
  'auth/credential/set': Schema.Struct({ account: Id, credential: LoginCredential }),
  'auth/login': Schema.Struct({ ...Provider, credential: LoginCredential }),
  /**
   * Restore a finished run's edited paths to their state before the run first
   * changed them (one entry, or every unreverted entry of the run). Refused
   * while the thread has an active run; `force` skips the conflict gate.
   */
  'checkpoint/revert': Schema.Struct({
    ...Command,
    ...Run,
    entryId: Schema.optional(Id),
    force: Schema.optional(Schema.Boolean),
  }),
  /** Provider availability: the host's configured keys, unreadable entries and env-file failures. */
  'host/status': Schema.Record(Schema.String, Schema.Never),
  'host/stop': Schema.Record(Schema.String, Schema.Never),
  initialize: Schema.Struct({
    hostVersion: Id,
    protocolVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    // Only a socket client authenticates with a token; a client bound to a
    // transport its launcher handed over is authorized by holding it.
    token: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  }),
  'interaction/respond': Schema.Struct({
    ...Command,
    ...Run,
    decision: Schema.Literals(['approve', 'deny']),
    grant: Schema.optional(PermissionGrant),
    interactionId: Id,
  }),
  'interaction/resume': Schema.Struct({
    ...Command,
    ...Run,
    grant: Schema.optional(PermissionGrant),
    interactionId: Id,
    resumeData: Schema.MutableJson,
  }),
  /** Every thread's runs and costed provider calls, as Core folds its committed log. */
  'ledger/read': Schema.Record(Schema.String, Schema.Never),
  'log/subscribe': Schema.Struct({ ...Thread, fromSeq: Seq }),
  'log/unsubscribe': Schema.Struct(Thread),
  /** Core's decision on an app's call under the thread's live policy; nothing runs. */
  'mcp/app/admit': Schema.Struct(McpAppCall),
  /** Decided afresh, an asked call runs only `approved`, on the app's own server. */
  'mcp/app/call': Schema.Struct({ ...McpAppCall, approved: Schema.Boolean }),
  'mcp/input/read': Schema.Struct(McpInput),
  'mcp/input/settle': Schema.Struct({
    ...Command,
    ...McpInput,
    action: Schema.Literals(['accept', 'decline', 'cancel']),
  }),
  // Values are process-local and never enter HostCommandLedger.
  'mcp/input/stage': Schema.Struct({ ...McpInput, content: Schema.optional(McpContent) }),
  /**
   * BST-2227: embeds one fixed probe text with the embedder these memory
   * settings select, resolved and credentialed as a run's admission resolves
   * it. Nothing is committed; a failure is the embedder's typed failure.
   */
  'memory/embedder/probe': HostMemoryEmbedderProbeParamsSchema,
  /** Model metadata through the host's OpenRouter key; the client sends only the model id. */
  'providers/openrouter-model': Schema.Struct({ model: Id }),
  /** The cheapest authenticated probe of one provider's stored or env credential. */
  'providers/verify': Schema.Struct(Provider),
  /**
   * BST-1932: human input for a running child. The active run ends after its
   * step in flight, and the input starts the child's next run under these run
   * settings; only that run's end reports to the parent.
   */
  'run/input': Schema.Struct({
    ...Command,
    ...Run,
    attachments: Schema.optional(Attachments),
    configuration: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    modelId: Id,
    ...PlanMode,
    prompt: Prompt,
  }).check(
    Schema.makeFilter((value) =>
      hasMessage(value) ? undefined : { issue: NO_MESSAGE.message, path: NO_MESSAGE.path ?? [] }
    )
  ),
  'run/regenerate': Schema.Struct({
    ...Command,
    ...Thread,
    configuration: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    modelId: Id,
    ...PlanMode,
    userMessageId: Id,
  }),
  'run/start': Schema.Struct({
    ...Command,
    ...Thread,
    attachments: Schema.optional(Attachments),
    configuration: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    modelId: Id,
    parentMessageId: Schema.optional(Schema.NullOr(Id)),
    ...PlanMode,
    prompt: Prompt,
  }).check(
    Schema.makeFilter((value) =>
      hasMessage(value) ? undefined : { issue: NO_MESSAGE.message, path: NO_MESSAGE.path ?? [] }
    )
  ),
  /**
   * End the active run gracefully at its next step boundary, after the step in
   * flight, so the user's steering message can start the next turn (BST-588).
   */
  'run/steer': Schema.Struct({ ...Command, ...Run }),
  'run/stop': Schema.Struct({ ...Command, ...Run }),
  /** A client verdict is always the user's; hook and revert labels are host-committed. */
  'run/verdict': Schema.Struct({
    ...Command,
    ...Run,
    detail: Schema.optional(RunVerdictDetailSchema),
    source: Schema.Literal('user'),
    verdict: RunVerdictSchema,
  }),
  /** BST-1932: a thread's direct child threads; they are never in `thread/list`. */
  'state/health/read': Schema.Record(Schema.String, Schema.Never),
  'thread/children': Schema.Struct(Thread),
  /** Destructive Root lifecycle; the existing StateStore intent owns recovery. */
  'thread/delete': Schema.Struct(Thread),
  'thread/list': Schema.Record(Schema.String, Schema.Never),
  /**
   * Memory readiness for the thread's next run: the admission `run/start`
   * makes with these fields, released at once. Nothing is committed.
   */
  'thread/memory/read': Schema.Struct({
    ...Thread,
    configuration: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    modelId: Id,
    ...PlanMode,
  }),
  'thread/read': Schema.Struct({ ...Thread, fromSeq: Seq }),
  ...REWIND_METHOD_SCHEMAS,
  ...SEARCH_METHOD_SCHEMAS,
  ...WORKSPACE_DISCOVERY_METHOD_SCHEMAS,
  ...WORKSPACE_FILES_METHOD_SCHEMAS,
  ...WORKSPACE_ROOTS_METHOD_SCHEMAS,
  ...SELECTION_METHOD_SCHEMAS,
  'thread/start': Schema.Struct(Command),
  'thread/update': Schema.Struct({ ...Command, ...Thread, ...ThreadPresentation }).check(
    Schema.makeFilter((params) =>
      Object.keys(params).length > 2
        ? undefined
        : { issue: 'A thread update changes no field', path: [] }
    )
  ),
  ...THREAD_WORKSPACE_METHOD_SCHEMAS,
} as const;
export type HostMethod = keyof typeof HOST_METHOD_SCHEMAS;
export type HostParams<M extends HostMethod> = (typeof HOST_METHOD_SCHEMAS)[M]['Type'];
/** Private input diagnostics must not quote schema paths or unknown secret-bearing keys. */
export function parseHostParams<M extends HostMethod>(method: M, input: unknown): HostParams<M> {
  if (!(method.startsWith('mcp/') || method.startsWith('auth/'))) {
    return wireDecoder(HOST_METHOD_SCHEMAS[method], {
      errors: 'all',
      onExcessProperty: 'error',
    })(input) as HostParams<M>;
  }
  const parsed = wireResultDecoder(HOST_METHOD_SCHEMAS[method], {
    errors: 'all',
    onExcessProperty: 'error',
  })(input);
  if (!(parsed._tag === 'Success')) {
    throw new Error('Invalid MCP host request');
  }
  return parsed.success as HostParams<M>;
}
const RunFields = { runId: Id };
const action = (json: JsonSchemaFactory) => ({
  ...RunFields,
  input: json(),
  toolCallId: Id,
  /** The user-facing catalog ID (`brainstrike.readWorkspaceFile`), not the provider-sanitized name. */
  toolCatalogId: Schema.optional(Id),
  toolId: Id,
  toolIdentity: Id,
});
const McpOrigin = {
  ...RunFields,
  configuredServerId: Id,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  toolCallId: Id,
  toolId: Id,
  toolIdentity: Id,
};
export const HostMcpInputRequestSchema = Schema.Struct({
  ...McpOrigin,
  interactionId: Id,
  invocationId: Id,
  mode: Schema.Literals(['form', 'url']),
  requestId: Schema.Union([Id, Schema.Int]),
  taskId: Schema.optional(Id),
  type: Schema.Literal('mcp.input.requested'),
});
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * A prepared provider prompt's composition (the context popover's breakdown).
 * The tool-call total and its per-tool rows are optional together: a receipt
 * without them did not measure tool calls, which is not the same as none.
 */
export const HostPromptBreakdownSchema = Schema.Struct({
  attachmentsCount: Tokens,
  historyMessagesTokens: Tokens,
  provenance: Schema.Literal('heuristic'),
  systemInstructionsTokens: Tokens,
  toolCallsByTool: Schema.optional(
    Schema.mutable(Schema.Array(Schema.Struct({ calls: Tokens, tokens: Tokens, toolName: Id })))
  ),
  toolCallsTokens: Schema.optional(Tokens),
  toolDefinitionsProvenance: Schema.Literals(['heuristic', 'measured']),
  toolDefinitionsTokens: Tokens,
}).check(
  Schema.makeFilter((breakdown) =>
    (breakdown.toolCallsTokens === undefined) === (breakdown.toolCallsByTool === undefined)
      ? undefined
      : { issue: 'toolCallsTokens and toolCallsByTool are committed together', path: [] }
  )
);
/**
 * The tool calls one provider request carried, as a change from the run's
 * previous request (assistant-contract `PromptToolCallWindow`): `run-start`
 * lists every call, `previous` only what entered, changed or left.
 */
export const HostPromptToolCallWindowSchema = Schema.Struct({
  base: Schema.Literals(['previous', 'run-start']),
  removed: Schema.mutable(Schema.Array(Id)),
  upserted: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        inputTokens: Tokens,
        output: Schema.Literals(['absent', 'full', 'marker']),
        outputTokens: Tokens,
        toolCallId: Id,
        toolName: Id,
      })
    )
  ),
});
/**
 * Every committed event, routed by its `type`; each member validates its full
 * shape. Two shapes that share a `type` are one member: the pipe's input
 * carries the `type` the union routes on, and its output union picks the shape.
 */
export function hostEventSchema(json: JsonSchemaFactory) {
  return Schema.Union(
    [
      Schema.Struct({
        binding: ThreadWorkspaceBindingSchema,
        /** ADR-0028 step 3: the root run that moved its thread into a worktree it created. */
        enteredBy: Schema.optional(Schema.Struct({ runId: Id })),
        type: Schema.Literal('workspace.binding.updated'),
      }),
      Schema.Struct({
        ...McpOrigin,
        handle: McpTaskHandleSchema,
        type: Schema.Literal('mcp.task.bound'),
      }),
      HostMcpInputRequestSchema,
      Schema.Struct({
        ...RunFields,
        action: Schema.Literals(['accept', 'decline', 'cancel']),
        commandId: Id,
        interactionId: Id,
        type: Schema.Literal('mcp.input.intent'),
      }),
      Schema.Struct({
        ...RunFields,
        interactionId: Id,
        status: Schema.Literals(['local-finalized', 'remote-acknowledged', 'unknown', 'retired']),
        type: Schema.Literal('mcp.input.settled'),
      }),
      Schema.Struct({
        ...RunFields,
        reason: Schema.String.check(Schema.isMinCodePoints(1)),
        serverId: Id,
        type: Schema.Literal('mcp.tools.unavailable'),
      }),
      Schema.StructWithRest(Schema.Struct({ type: Schema.Literal('thread.started') }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]).pipe(
        Schema.decodeTo(
          Schema.Union([
            Schema.Struct({ commandId: Id, type: Schema.Literal('thread.started') }),
            Schema.Struct({
              origin: HostChildOriginSchema,
              type: Schema.Literal('thread.started'),
            }),
          ])
        )
      ),
      Schema.Struct({ ...ThreadPresentation, type: Schema.Literal('thread.updated') }),
      Schema.Struct({
        snapshot: WorkspaceSnapshotSchema,
        type: Schema.Literal('workspace.updated'),
      }),
      ...selectionEventSchemas(json),
      Schema.Struct({
        commandId: Id,
        method: Id,
        payload: json(),
        result: json(),
        type: Schema.Literal('command.accepted'),
      }),
      Schema.Struct({
        type: Schema.Literal('run.started'),
        ...RunFields,
        attachments: Schema.optional(Attachments),
        delivery: Schema.optional(HostChildDeliverySchema),
        modelId: Id,
        parentMessageId: Schema.optional(Schema.NullOr(Id)),
        parentRunId: Schema.optional(Id),
        ...PlanMode,
        prompt: Prompt,
        snapshot: Schema.optional(hostRunSnapshotSchema(json)),
        userMessageId: Schema.optional(Id),
      }),
      Schema.Struct({ type: Schema.Literal('stream.chunk'), ...RunFields, chunk: json() }),
      Schema.Struct({
        type: Schema.Literal('model.step'),
        ...RunFields,
        messages: Schema.mutable(Schema.Array(json())),
        model: json(),
        stepNumber: Seq,
        usage: json(),
      }),
      Schema.Struct({
        type: Schema.Literal('model.messages'),
        ...RunFields,
        messages: Schema.mutable(Schema.Array(json())),
      }),
      Schema.Struct({
        type: Schema.Literal('memory.usage'),
        ...RunFields,
        // BST-2226: `embedding` is a hosted memory embedder's provider-reported tokens.
        kind: Schema.Literals(['observation', 'reflection', 'embedding']),
        modelId: Id,
        usage: json(),
      }),
      HostMemoryCycleEventSchema,
      Schema.Struct({
        type: Schema.Literal('memory.observation.withheld'),
        ...RunFields,
        reason: Schema.Literal('branched-thread'),
      }),
      Schema.Struct({
        type: Schema.Literal('memory.settlement.failed'),
        ...RunFields,
        detail: Schema.String.check(Schema.isMinCodePoints(1)),
      }),
      // A turn's failed semantic recall, which the turn answers without.
      Schema.Struct({
        type: Schema.Literal('memory.recall.failed'),
        ...RunFields,
        detail: Schema.String.check(Schema.isMinCodePoints(1)),
      }),
      Schema.Struct({
        type: Schema.Literal('provider.request.prepared'),
        ...RunFields,
        accounting: json(),
        breakdown: Schema.optional(HostPromptBreakdownSchema),
        modelId: Id,
        provider: Id,
        toolCallWindow: Schema.optional(HostPromptToolCallWindowSchema),
      }),
      Schema.Struct({
        type: Schema.Literal('interaction.requested'),
        ...action(json),
        executionContext: Schema.optional(json()),
        interactionId: Id,
        kind: Schema.Literals(['approval', 'question', 'plan', 'network']),
        origin: Schema.optional(HostBrowserOriginSchema),
        /** Auto access mode's note on why this call still needs the user. */
        reason: Schema.optional(Schema.String.check(Schema.isMinCodePoints(1))),
        risk: Schema.optional(RiskCategory),
        ...HOST_APPROVAL_FACT_FIELDS,
      }),
      Schema.StructWithRest(Schema.Struct({ type: Schema.Literal('interaction.responded') }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]).pipe(
        Schema.decodeTo(
          Schema.Union([
            Schema.Struct({
              type: Schema.Literal('interaction.responded'),
              ...RunFields,
              by: Schema.optional(Schema.Literal('policy')),
              decision: Schema.Literals(['approve', 'deny']),
              interactionId: Id,
            }),
            Schema.Struct({
              type: Schema.Literal('interaction.responded'),
              ...RunFields,
              by: Schema.optional(Schema.Literal('policy')),
              interactionId: Id,
              resumeData: json(),
            }),
          ])
        )
      ),
      Schema.Struct({ type: Schema.Literal('effect.started'), ...action(json) }),
      Schema.Struct({
        type: Schema.Literal('effect.finished'),
        ...RunFields,
        output: json(),
        projectionClipped: Schema.optional(Schema.Literal(true)),
        toolCallId: Id,
      }),
      Schema.Struct({
        type: Schema.Literal('run.finished'),
        ...RunFields,
        detail: Schema.optional(Schema.String),
        outcome: Schema.Literals(['completed', 'failed', 'stopped', 'interrupted']),
      }),
      Schema.Struct({
        type: Schema.Literal('run.attempt'),
        ...RunFields,
        attempt: Schema.Int.check(Schema.isGreaterThan(0)),
        detail: Schema.String.check(Schema.isMinCodePoints(1)),
        maxAttempts: Schema.Int.check(Schema.isGreaterThan(0)),
        reason: Schema.Literals([
          'stalled',
          'provider-error',
          'empty-response',
          'context-overflow',
        ]),
        recovered: Schema.Boolean,
        refusal: Schema.optional(
          Schema.Literals(['budget-exhausted', 'tool-parts', 'committed-output'])
        ),
        stall: Schema.optional(
          Schema.Struct({
            lastPartType: Schema.optional(Id),
            partsSeen: Seq,
            // 'tool-executing' is written by no current build; stored rows keep it.
            phase: Schema.Literals(['awaiting-output', 'reasoning', 'streaming', 'tool-executing']),
          })
        ),
      }),
      Schema.Struct({
        type: Schema.Literal('tool.projection.rewritten'),
        ...RunFields,
        rewrites: Schema.mutable(
          Schema.Array(
            Schema.Union([
              Schema.Struct({
                kind: Schema.Literal('prune'),
                markerText: Schema.String.check(Schema.isPattern(/\S/u)),
                supersededByToolCallId: Schema.Null,
                toolCallId: Id,
              }),
              Schema.Struct({
                kind: Schema.Literal('supersession'),
                markerText: Schema.String.check(Schema.isPattern(/\S/u)),
                supersededByToolCallId: Id,
                toolCallId: Id,
              }),
            ])
          )
        ).check(Schema.isMinLength(1)),
      }),
      Schema.Struct({
        type: Schema.Literal('context.compacted'),
        ...RunFields,
        compactedRunIds: Schema.mutable(Schema.Array(Id)).check(Schema.isMinLength(1)),
        kind: Schema.Literals(['agentic', 'deterministic']),
        modelId: Schema.optional(Id),
        reason: Schema.Literals(['pre-request', 'context-overflow']),
        /**
         * A deterministic fallback's reason: the agentic summarizer's typed
         * failure code, and the reference its cause is logged under (BST-2204).
         */
        summarizerFailure: Schema.optional(
          Schema.Struct({
            code: Id,
            correlationId: Schema.optional(Schema.String.check(Schema.isUUID())),
          })
        ),
        summary: Schema.String.check(Schema.isMinCodePoints(1)),
        usage: Schema.optional(json()),
      }),
      Schema.Struct({
        type: Schema.Literal('workspace.edit.recorded'),
        ...RunFields,
        after: HostFileIdentitySchema,
        baselines: Schema.mutable(Schema.Array(HostEditBaselineSchema)),
        before: HostFileIdentitySchema,
        blobRefs: Schema.optional(Schema.mutable(Schema.Array(Sha256))),
        entryId: Id,
        fromPath: Schema.optional(WorkspaceRelativePath),
        op: HostWorkspaceEditOpSchema,
        path: WorkspaceRelativePath,
        rootId: Id,
        rootPath: Id,
        toolCallId: Id,
        toolId: Id,
      }),
      Schema.Struct({
        type: Schema.Literal('tool.state.updated'),
        ...RunFields,
        key: Id,
        toolCallId: Id,
        value: json(),
      }),
      Schema.Struct({
        type: Schema.Literal('workspace.edit.reverted'),
        ...RunFields,
        commandId: Id,
        outcomes: Schema.mutable(Schema.Array(HostEditRevertOutcomeSchema)),
      }),
      Schema.Struct({
        type: Schema.Literal('workspace.snapshot.recorded'),
        ...RunFields,
        boundary: Schema.Literals(['turn-start', 'turn-end']),
        failure: Schema.optional(Schema.String.check(Schema.isMinCodePoints(1))),
        roots: Schema.mutable(Schema.Array(HostTurnSnapshotSchema)),
      }),
      ...REWIND_EVENT_SCHEMAS,
      Schema.Struct({
        type: Schema.Literal('references.unavailable'),
        ...RunFields,
        files: Schema.mutable(Schema.Array(ReferencedFileFailureSchema)).check(
          Schema.isMinLength(1)
        ),
      }),
      Schema.Struct({
        type: Schema.Literal('hooks.skipped'),
        ...RunFields,
        files: Schema.mutable(Schema.Array(HostHookSkipSchema)).check(Schema.isMinLength(1)),
      }),
      Schema.Struct({
        type: Schema.Literal('permission.granted'),
        ...RunFields,
        grant: PermissionGrant,
      }),
      Schema.Struct({
        type: Schema.Literal('worktree.created'),
        ...RunFields,
        branch: Schema.NullOr(Schema.String.check(Schema.isMinCodePoints(1))),
        path: Schema.String.check(Schema.isMinCodePoints(1)),
        toolCallId: Id,
        via: Schema.Literal('shell'),
        worktreeId: Id,
      }),
      Schema.Struct({
        type: Schema.Literal('hook.context'),
        ...RunFields,
        context: Schema.String.check(Schema.isMinCodePoints(1)),
        toolCallId: Schema.optional(Id),
      }),
      Schema.Struct({
        type: Schema.Literal('run.verdict'),
        ...RunFields,
        detail: Schema.optional(RunVerdictDetailSchema),
        source: RunVerdictSourceSchema,
        verdict: RunVerdictSchema,
      }),
    ],
    { mode: 'oneOf' }
  );
}
export const HostEventSchema = hostEventSchema(() => Schema.MutableJson);
export type HostEvent = (typeof HostEventSchema)['Type'];
export const HostLogRowSchema = Schema.Struct({
  event: HostEventSchema,
  seq: Schema.Int.check(Schema.isGreaterThan(0)),
  threadId: Id,
  ts: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type HostLogRow = (typeof HostLogRowSchema)['Type'];
export const HOST_RESULT_SCHEMAS = {
  ...CANVAS_RESULT_SCHEMAS,
  ...GIT_WORKSPACE_RESULT_SCHEMAS,
  ...HOOK_TRUST_RESULT_SCHEMAS,
  ...MCP_CONTENT_RESULT_SCHEMAS,
  ...MCP_PRESENTATION_RESULT_SCHEMAS,
  ...MCP_SETTINGS_RESULT_SCHEMAS,
  ...PERMISSION_POLICY_RESULT_SCHEMAS,
  ...TERMINAL_RESULT_SCHEMAS,
  'auth/credential/delete': Schema.Struct({ deleted: Schema.Boolean }),
  'auth/credential/set': Schema.Struct({ stored: Schema.Literal(true) }),
  'auth/login': Schema.Struct({ stored: Schema.Literal(true) }),
  'checkpoint/revert': Schema.Struct({
    outcomes: Schema.mutable(Schema.Array(HostEditRevertOutcomeSchema)),
  }),
  // The renderer validates the availability payload strictly (use-assistant-availability).
  'host/status': Schema.Record(Schema.String, Schema.MutableJson),
  'host/stop': Schema.Struct({
    outcome: Schema.Literal('stopped'),
    rootReleased: Schema.Literal(true),
  }),
  initialize: Schema.Struct({
    hostVersion: Id,
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    protocolVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    start: Id,
  }),
  'interaction/respond': Schema.Struct({ accepted: Schema.Literal(true) }),
  'interaction/resume': Schema.Struct({ accepted: Schema.Literal(true) }),
  'ledger/read': Schema.Struct({ threads: Schema.mutable(Schema.Array(HostLedgerThreadSchema)) }),
  'log/subscribe': Schema.Struct({
    rows: Schema.mutable(Schema.Array(HostLogRowSchema)),
    telemetry: Schema.mutable(Schema.Array(HostRunTelemetrySchema)),
  }),
  'log/unsubscribe': Schema.Struct({ unsubscribed: Schema.Literal(true) }),
  'mcp/app/admit': Schema.Struct({
    decision: Schema.Literals(['allow', 'ask']),
    riskCategory: RiskCategory,
  }),
  'mcp/app/call': Schema.Struct({ result: Schema.MutableJson }),
  'mcp/input/read': Schema.Struct({
    presentation: Schema.optional(Schema.MutableJson),
    request: HostMcpInputRequestSchema,
    status: HostMcpInputStatusSchema,
  }),
  'mcp/input/settle': Schema.Struct({
    accepted: Schema.Literal(true),
    status: HostMcpInputStatusSchema,
  }),
  'mcp/input/stage': Schema.Struct({ staged: Schema.Literal(true) }),
  'memory/embedder/probe': HostMemoryEmbedderProbeResultSchema,
  'providers/openrouter-model': opaqueWireSchema(
    (value): OpenRouterModelMetadataSnapshot => parseOpenRouterModelMetadataSnapshot(value)
  ),
  'providers/verify': opaqueWireSchema(
    (value): ProviderVerificationSnapshot => parseProviderVerificationSnapshot(value)
  ),
  'run/input': Schema.Struct({ accepted: Schema.Literal(true) }),
  'run/regenerate': Schema.Struct({ runId: Id }),
  'run/start': Schema.Struct({ runId: Id }),
  'run/steer': Schema.Struct({ outcome: Schema.Literals(['steering', 'already-terminal']) }),
  'run/stop': Schema.Struct({ outcome: Schema.Literals(['stopped', 'already-terminal']) }),
  'run/verdict': Schema.Struct({ accepted: Schema.Literal(true) }),
  'state/health/read': HostStateHealthSchema,
  'thread/children': Schema.Struct({
    children: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          ...Thread,
          callSign: Schema.String.check(Schema.isMinCodePoints(1)),
          color: Schema.String.check(Schema.isMinCodePoints(1)),
          origin: HostChildOriginSchema,
          status: HostChildStatusSchema,
        })
      )
    ),
  }),
  'thread/delete': Schema.Struct({
    deleted: Schema.Literal(true),
    threadIds: Schema.mutable(Schema.Array(Id)).check(Schema.isMinLength(1)),
  }),
  'thread/list': Schema.Struct({
    threads: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          ...Thread,
          ...ThreadPresentation,
          binding: Schema.NullOr(ThreadWorkspaceBindingSchema),
          createdAt: StoredTime,
          damage: Schema.optional(Schema.String.check(Schema.isMinCodePoints(1))),
          latestRun: Schema.optional(HostLatestRunSchema),
          updatedAt: StoredTime,
        })
      )
    ),
  }),
  // Not ready: the reason `run/start` would fail with; the observation needs an admission.
  'thread/memory/read': Schema.Union([
    Schema.Struct({
      admission: Schema.Struct({ ready: Schema.Literal(true) }),
      models: Schema.optional(HostMemoryModelsSchema),
      observational: HostObservationalMemoryStateSchema,
    }),
    Schema.Struct({
      admission: Schema.Struct({
        ready: Schema.Literal(false),
        reason: Schema.String.check(Schema.isMinCodePoints(1)),
      }),
    }),
  ]),
  'thread/read': Schema.Struct({ rows: Schema.mutable(Schema.Array(HostLogRowSchema)) }),
  ...REWIND_RESULT_SCHEMAS,
  ...SEARCH_RESULT_SCHEMAS,
  ...WORKSPACE_DISCOVERY_RESULT_SCHEMAS,
  ...WORKSPACE_FILES_RESULT_SCHEMAS,
  ...WORKSPACE_ROOTS_RESULT_SCHEMAS,
  ...SELECTION_RESULT_SCHEMAS,
  'thread/start': Schema.Struct(Thread),
  'thread/update': Schema.Struct({ accepted: Schema.Literal(true) }),
  ...THREAD_WORKSPACE_RESULT_SCHEMAS,
} as const;
export type HostResults = { [M in HostMethod]: (typeof HOST_RESULT_SCHEMAS)[M]['Type'] };
