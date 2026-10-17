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
import { HostAuthStatusSchema, HostAuthVerdictSchema } from './auth-wire.js';
import type { JsonSchemaFactory } from './json-value.js';
import { HostLatestRunSchema, HostLedgerThreadSchema } from './ledger-wire.js';
import { McpToolAuthoritySchema } from './mcp-authority-wire.js';
import { MCP_CONTENT_METHOD_SCHEMAS, MCP_CONTENT_RESULT_SCHEMAS } from './protocol-mcp-content.js';
import {
  MCP_PRESENTATION_METHOD_SCHEMAS,
  MCP_PRESENTATION_RESULT_SCHEMAS,
} from './protocol-mcp-presentation.js';
import {
  MCP_SETTINGS_METHOD_SCHEMAS,
  MCP_SETTINGS_RESULT_SCHEMAS,
} from './protocol-mcp-settings.js';
import {
  PERMISSION_POLICY_METHOD_SCHEMAS,
  PERMISSION_POLICY_RESULT_SCHEMAS,
} from './protocol-permission-policy.js';
import {
  REWIND_EVENT_SCHEMAS,
  REWIND_METHOD_SCHEMAS,
  REWIND_RESULT_SCHEMAS,
} from './protocol-rewind.js';
import { SEARCH_METHOD_SCHEMAS, SEARCH_RESULT_SCHEMAS } from './protocol-search.js';
import {
  SELECTION_METHOD_SCHEMAS,
  SELECTION_RESULT_SCHEMAS,
  selectionEventSchemas,
} from './protocol-selection.js';
import {
  RunVerdictDetailSchema,
  RunVerdictSchema,
  RunVerdictSourceSchema,
} from './run-verdict-wire.js';
import { HostHookSkipSchema, HostImageAttachmentSchema } from './run-wire.js';
import {
  HostEditBaselineSchema,
  HostEditRevertOutcomeSchema,
  HostFileIdentitySchema,
  HostTurnSnapshotSchema,
  HostWorkspaceEditOpSchema,
  Sha256,
  WorkspaceRelativePath,
} from './workspace-wire.js';

export * from './client-open-external-wire.js';
export * from './mcp-authority-wire.js';
export * from './protocol-mcp-content.js';
export * from './protocol-mcp-presentation.js';
export * from './protocol-mcp-settings.js';
export * from './protocol-permission-policy.js';
export * from './protocol-rewind.js';
export * from './protocol-search.js';
export * from './protocol-selection.js';
export * from './run-wire.js';
export * from './workspace-wire.js';
// 11: committed branch history (`run/start` parentMessageId, `run/regenerate`,
// and the explicit branch links they commit on `run.started`), thread
// presentation (`thread/update`, `thread.updated`: title, colour and icon, also
// in `thread/list`), withheld observational memory, tool catalog IDs on
// committed tool events, image attachments on a user message (`run/start`
// and `run.started`), committed workspace edit attribution,
// `checkpoint/revert`, per-thread tool state, the prompt breakdown on
// `provider.request.prepared`, `run/steer` (end the active run at its next
// step boundary), run attempt records, `mcp.tools.unavailable`, committed with
// `run.started` for each configured MCP server whose tools the run proceeds
// without, permission grants answered with an approval (`interaction/respond`
// grant, `permission.granted`, the request's risk), plan mode (`run/start`,
// `run/regenerate` and `run.started` planMode), child threads (BST-1932):
// `thread.started` with a delegation `origin`, the child results a
// `run.started` delivers, an approval the root's policy answered, and
// `thread/children` (a thread's direct children), lifecycle hook context
// (`hook.context`), host-owned project hook trust (`hooks/trust`,
// `hooks/trust/read`, `hooks/untrust`), `thread/memory/read` (memory
// readiness for the next run), run_python's network consent (an
// `interaction.requested` of kind `network`, answered by `interaction/resume`
// with `{ action }` and, when the policy also asked, an approval grant), a
// run's turn snapshots for its Changes review (`workspace.snapshot.recorded`),
// restore to before a message (`thread/rewind/preview`, `thread/rewind`,
// `thread/rewind/redo`; `thread.rewind.started`, `thread.rewound`,
// `thread.rewind.redo.started`, `thread.rewind.redone`,
// `thread.rewind.interrupted`), the hook files a run did not load
// (`hooks.skipped`), `ledger/read` (every thread's runs and costed provider calls, as Core folds
// them), the threads `thread/delete` deleted (`threadIds`), and the desktop's
// MCP settings (`mcp/config/*`, `mcp/extensions/*`, `mcp/tools/*`,
// `mcp/settings/subscribe` and its `mcp/settings/event`) with server status and
// control (`mcp/status/read`, `mcp/server/control`, the event's `status`
// variant), and its MCP presentations (`mcp/tasks/list`, `mcp/tasks/act`,
// `mcp/elicitation/settle`, `mcp/presentation/subscribe` and its
// `mcp/presentation/event`), content browsing (`mcp/content/complete`,
// `mcp/content/prompt`, `mcp/content/read`), an MCP App's own tool calls
// (`mcp/app/admit`, `mcp/app/call`), which Core decides under the owning
// thread's policy, and `worktree.created` (a worktree a call's shell command
// made, which the desktop adopted), and a provider request's tool calls (the
// breakdown's `toolCallsTokens` and `toolCallsByTool`, and the request's
// `toolCallWindow`). These additions are optional fields, new
// variants and new methods, so a v11 reader that uses none of them sees
// nothing new.
export const AGENT_HOST_PROTOCOL_VERSION = 11;
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
/**
 * BST-1990 (D4): the workspace folder a tool resolved for one call, so its
 * approval names the folder even when the call gave no `root`.
 */
export const HostApprovalTargetRootSchema = Schema.Struct({
  displayName: Schema.String.check(Schema.isMinCodePoints(1)),
  rootId: Id,
});
export type HostApprovalTargetRoot = (typeof HostApprovalTargetRootSchema)['Type'];
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
/**
 * The answer to a `network` interaction: allow lets this one call reach its
 * requested domains; deny settles it unrun (run_python's `network_denied`).
 */
export const HostNetworkConsentSchema = Schema.Struct({
  action: Schema.Literals(['allow', 'deny']),
});
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
/** A key a user supplies directly. Subscription OAuth is never a login payload. */
export type HostLoginCredential = Exclude<
  ProviderCredential,
  {
    readonly type: 'oauth';
  }
>;
const LoginCredential = Schema.declare<HostLoginCredential>(
  (value) => isProviderCredential(value) && value.type !== 'oauth'
);
const Provider = { provider: Id };
/** A workspace root by its durable ID: the desktop's DB `roots.id`. */
const HookRoot = { rootId: Id };
/**
 * A root's trusted project hooks: its absolute path and the SHA-256 of
 * `<path>/.brainstrike/hooks.json`'s raw bytes. The host is the only writer.
 */
export const HostHookTrustSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinCodePoints(1)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type HostHookTrust = (typeof HostHookTrustSchema)['Type'];
/** Why observational memory waits for an observer it can run. */
export const HOST_OBSERVER_AWAITING_REASONS = [
  'keys-unknown',
  'model-not-eligible',
  'no-backend',
  'no-hosted-chat-provider',
] as const;
export type HostObserverAwaitingReason = (typeof HOST_OBSERVER_AWAITING_REASONS)[number];
const ObservationTokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * Observational memory as a run admission configures it. `active` carries the
 * thread's committed observation record, or null before the first observation.
 */
export const HostObservationalMemoryStateSchema = Schema.Union(
  [
    Schema.Struct({ state: Schema.Literal('off') }),
    Schema.Struct({
      reason: Schema.Literals(HOST_OBSERVER_AWAITING_REASONS),
      state: Schema.Literal('awaiting-observer'),
    }),
    Schema.Struct({
      record: Schema.NullOr(
        Schema.Struct({
          bufferedObservationTokens: ObservationTokens,
          messageTokenThreshold: Schema.Int.check(Schema.isGreaterThan(0)),
          observationTokenCount: ObservationTokens,
          pendingMessageTokens: ObservationTokens,
          totalTokensObserved: ObservationTokens,
        })
      ),
      state: Schema.Literal('active'),
    }),
  ],
  { mode: 'oneOf' }
);
export type HostObservationalMemoryState = (typeof HostObservationalMemoryStateSchema)['Type'];
export const HOST_METHOD_SCHEMAS = {
  ...MCP_CONTENT_METHOD_SCHEMAS,
  ...MCP_PRESENTATION_METHOD_SCHEMAS,
  ...MCP_SETTINGS_METHOD_SCHEMAS,
  ...PERMISSION_POLICY_METHOD_SCHEMAS,
  // auth/* is secret-bearing: process-local, never in HostCommandLedger, the log
  // or diagnostics. The host is the single writer and token holder.
  'auth/cancel': Schema.Struct(Provider),
  'auth/clear': Schema.Record(Schema.String, Schema.Never),
  'auth/connect': Schema.Struct({
    ...Provider,
    method: Schema.optional(Schema.Literals(['device', 'loopback'])),
  }),
  'auth/credential/delete': Schema.Struct({ account: Id }),
  'auth/credential/set': Schema.Struct({ account: Id, credential: LoginCredential }),
  'auth/disconnect': Schema.Struct(Provider),
  'auth/login': Schema.Struct({ ...Provider, credential: LoginCredential }),
  'auth/status': Schema.Struct(Provider),
  'auth/verify': Schema.Struct(Provider),
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
  /**
   * Trust a root's project hooks at the hash its reviewer saw. The host
   * re-hashes the file and refuses a mismatch; a later edit needs a new trust.
   */
  'hooks/trust': Schema.Struct({ ...HookRoot, ...HostHookTrustSchema.fields }),
  'hooks/trust/read': Schema.Struct(HookRoot),
  /** Revoke a root's trust; removing the root revokes it too. */
  'hooks/untrust': Schema.Struct(HookRoot),
  /** Provider availability: the host's configured keys, unreadable entries and env-file failures. */
  'host/status': Schema.Record(Schema.String, Schema.Never),
  'host/stop': Schema.Record(Schema.String, Schema.Never),
  initialize: Schema.Struct({
    hostVersion: Id,
    protocolVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
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
  ...SELECTION_METHOD_SCHEMAS,
  'thread/start': Schema.Struct(Command),
  'thread/update': Schema.Struct({ ...Command, ...Thread, ...ThreadPresentation }).check(
    Schema.makeFilter((params) =>
      Object.keys(params).length > 2
        ? undefined
        : { issue: 'A thread update changes no field', path: [] }
    )
  ),
  'thread/workspace/binding/read': Schema.Struct(Thread),
  'thread/workspace/binding/update': Schema.Struct({
    ...Command,
    ...Thread,
    patch: ThreadWorkspaceBindingSchema,
  }),
  'thread/workspace/read': Schema.Struct(Thread),
  'thread/workspace/set': Schema.Struct({
    ...Command,
    ...Thread,
    snapshot: WorkspaceSnapshotSchema,
  }),
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
        kind: Schema.Literals(['observation', 'reflection']),
        modelId: Id,
        usage: json(),
      }),
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
        risk: Schema.optional(RiskCategory),
        targetRoot: Schema.optional(HostApprovalTargetRootSchema),
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
                markerText: Schema.String.check(Schema.isPattern(/\S/)),
                supersededByToolCallId: Schema.Null,
                toolCallId: Id,
              }),
              Schema.Struct({
                kind: Schema.Literal('supersession'),
                markerText: Schema.String.check(Schema.isPattern(/\S/)),
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
  ...MCP_CONTENT_RESULT_SCHEMAS,
  ...MCP_PRESENTATION_RESULT_SCHEMAS,
  ...MCP_SETTINGS_RESULT_SCHEMAS,
  ...PERMISSION_POLICY_RESULT_SCHEMAS,
  'auth/cancel': HostAuthStatusSchema,
  'auth/clear': Schema.Struct({ cleared: Schema.Boolean }),
  'auth/connect': HostAuthStatusSchema,
  'auth/credential/delete': Schema.Struct({ deleted: Schema.Boolean }),
  'auth/credential/set': Schema.Struct({ stored: Schema.Literal(true) }),
  'auth/disconnect': HostAuthStatusSchema,
  'auth/login': Schema.Struct({ stored: Schema.Literal(true) }),
  'auth/status': HostAuthStatusSchema,
  'auth/verify': HostAuthVerdictSchema,
  'checkpoint/revert': Schema.Struct({
    outcomes: Schema.mutable(Schema.Array(HostEditRevertOutcomeSchema)),
  }),
  'hooks/trust': Schema.Struct({ trusted: Schema.Literal(true) }),
  'hooks/trust/read': Schema.Struct({ trust: Schema.NullOr(HostHookTrustSchema) }),
  /** Whether a trust was revoked; false when the root had none. */
  'hooks/untrust': Schema.Struct({ untrusted: Schema.Boolean }),
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
  ...SELECTION_RESULT_SCHEMAS,
  'thread/start': Schema.Struct(Thread),
  'thread/update': Schema.Struct({ accepted: Schema.Literal(true) }),
  'thread/workspace/binding/read': Schema.Struct({
    binding: Schema.NullOr(ThreadWorkspaceBindingSchema),
  }),
  'thread/workspace/binding/update': Schema.Struct({ accepted: Schema.Literal(true) }),
  'thread/workspace/read': Schema.Struct({ snapshot: Schema.NullOr(WorkspaceSnapshotSchema) }),
  'thread/workspace/set': Schema.Struct({ accepted: Schema.Literal(true) }),
} as const;
export type HostResults = {
  [M in HostMethod]: (typeof HOST_RESULT_SCHEMAS)[M]['Type'];
};
