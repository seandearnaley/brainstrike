import {
  isProviderCredential,
  type OpenRouterModelMetadataSnapshot,
  type ProviderCredential,
  type ProviderVerificationSnapshot,
  parseOpenRouterModelMetadataSnapshot,
  parseProviderVerificationSnapshot,
  TOOL_RISK_CATEGORIES,
} from '@brainstrike/assistant-contract';
import {
  ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE,
  SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES,
} from '@brainstrike/assistant-contract/assistant-attachments';
import { McpTaskHandleSchema } from '@brainstrike/assistant-contract/mcp-task-presentation';
import { ThreadWorkspaceBindingSchema } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import { z } from 'zod';
import { HostAuthStatusSchema, HostAuthVerdictSchema } from './auth-wire.js';
import { HostLedgerThreadSchema } from './ledger-wire.js';
import { MCP_CONTENT_METHOD_SCHEMAS, MCP_CONTENT_RESULT_SCHEMAS } from './protocol-mcp-content.js';
import {
  MCP_PRESENTATION_METHOD_SCHEMAS,
  MCP_PRESENTATION_RESULT_SCHEMAS,
} from './protocol-mcp-presentation.js';
import {
  MCP_SETTINGS_METHOD_SCHEMAS,
  MCP_SETTINGS_RESULT_SCHEMAS,
} from './protocol-mcp-settings.js';

export * from './protocol-mcp-content.js';
export * from './protocol-mcp-presentation.js';
export * from './protocol-mcp-settings.js';

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
// `ledger/read` (every thread's runs and costed provider calls, as Core folds
// them), the threads `thread/delete` deleted (`threadIds`), and the desktop's
// MCP settings (`mcp/config/*`, `mcp/extensions/*`, `mcp/tools/*`,
// `mcp/settings/subscribe` and its `mcp/settings/event`) with server status and
// control (`mcp/status/read`, `mcp/server/control`, the event's `status`
// variant), and its MCP presentations (`mcp/tasks/list`, `mcp/tasks/act`,
// `mcp/elicitation/settle`, `mcp/presentation/subscribe` and its
// `mcp/presentation/event`) and content browsing (`mcp/content/complete`,
// `mcp/content/prompt`, `mcp/content/read`). These additions are optional fields, new variants
// and new methods, so a v11 reader that uses none of them sees nothing new.
export const AGENT_HOST_PROTOCOL_VERSION = 11;

// ADR-0017: transport request IDs never serve as durable command identities.
const Id = z.string().min(1);
const Command = { commandId: Id };
const Thread = { threadId: Id };
/** A committed thread title: trimmed, never blank. */
const ThreadTitle = z.string().trim().min(1);
/** A thread's committed presentation; each field is optional and set independently. */
const ThreadPresentation = {
  color: Id.optional(),
  icon: Id.optional(),
  title: ThreadTitle.optional(),
};
const Run = { ...Thread, runId: Id };
/**
 * Plan mode: the run may only read and propose a plan. Approving its plan ends
 * it and starts the thread's next run without plan mode.
 */
const PlanMode = { planMode: z.literal(true).optional() };
const RiskCategory = z.enum(TOOL_RISK_CATEGORIES);
/**
 * A grant answered with an approval: the rest of that run allows the call's
 * risk category (`session`; the client keeps it for its later runs) or the
 * call's tool. Core accepts only the approved call's own category or tool.
 */
const PermissionGrant = z.discriminatedUnion('scope', [
  z.strictObject({ category: RiskCategory, scope: z.literal('session') }),
  z.strictObject({ scope: z.literal('tool'), toolId: Id }),
]);
export type HostPermissionGrant = z.infer<typeof PermissionGrant>;

/**
 * The answer to a `network` interaction: allow lets this one call reach its
 * requested domains; deny settles it unrun (run_python's `network_denied`).
 */
export const HostNetworkConsentSchema = z.strictObject({ action: z.enum(['allow', 'deny']) });
/** Task Ledger run labels (brainstrike_assistant_run_outcomes verdict/source). */
const RunVerdict = z.enum(['failed', 'mixed', 'succeeded']);
const RunVerdictDetail = z.string().max(2000);
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
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/** Root-relative POSIX path: no leading slash, no empty, `.` or `..` segment. */
const WorkspaceRelativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'Expected a normalized root-relative path'
  );
export const HOST_WORKSPACE_EDIT_OPS = ['write', 'string_replace', 'delete', 'rename'] as const;
export const HostWorkspaceEditOpSchema = z.enum(HOST_WORKSPACE_EDIT_OPS);
export type HostEditOp = (typeof HOST_WORKSPACE_EDIT_OPS)[number];
/** A file's observed identity; content is never part of the client-visible event. */
const HostFileIdentitySchema = z.strictObject({
  existed: z.boolean(),
  hash: Sha256.nullable(),
  size: z.number().int().nonnegative().nullable(),
});
/**
 * A path's state before the run first changed it. Content lives in a
 * content-addressed StateStore blob that this event references (`blobRefs`).
 */
export const HostEditBaselineSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absent'), path: WorkspaceRelativePath }),
  z.strictObject({
    blob: Sha256,
    bytes: z.number().int().nonnegative(),
    encoding: z.enum(['utf8', 'base64']),
    hash: Sha256,
    kind: z.literal('content'),
    mode: z.number().int().nonnegative(),
    path: WorkspaceRelativePath,
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    path: WorkspaceRelativePath,
    reason: z.enum(['too_large', 'symlink', 'not_a_file']),
  }),
]);
export type HostEditBaseline = z.infer<typeof HostEditBaselineSchema>;
export const HostEditRevertOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ entryId: Id, status: z.literal('reverted') }),
  z.strictObject({
    entryId: Id,
    reason: z.string().min(1),
    status: z.enum(['conflict', 'not_revertible']),
  }),
]);
export type HostEditRevertOutcome = z.infer<typeof HostEditRevertOutcomeSchema>;
/** A workspace root as a turn's snapshot names it: its durable ID and absolute path. */
export const HostTurnSnapshotRootSchema = z.strictObject({
  rootId: Id,
  rootPath: z.string().min(1),
});
export type HostTurnSnapshotRoot = z.infer<typeof HostTurnSnapshotRootSchema>;
/**
 * One root's snapshot at a turn boundary: the platform's snapshot commit. The
 * null object ID records a capture that failed for this root, so the turn's
 * Changes review fails visibly rather than showing part of its changes.
 */
export const HostTurnSnapshotSchema = z.strictObject({
  ...HostTurnSnapshotRootSchema.shape,
  commitOid: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export type HostTurnSnapshot = z.infer<typeof HostTurnSnapshotSchema>;
/**
 * An image on a user message, as the composer encodes it: a base64 data URL.
 * Core admits it against the shared attachment contract's caps.
 */
export const HostImageAttachmentSchema = z.strictObject({
  data: z.string().min(1),
  mediaType: z.enum(SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES),
  /** The attached file's name, shown with the image. */
  name: z.string().min(1).max(255),
  type: z.literal('image'),
});
export type HostImageAttachment = z.infer<typeof HostImageAttachmentSchema>;
const Attachments = z
  .array(HostImageAttachmentSchema)
  .min(1)
  .max(ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE);
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
  /**
   * The persona as it was admitted: what the child's toolbar names, never the
   * current persona list. Children committed before it carry none.
   */
  profile: z
    .strictObject({ label: z.string().min(1), mode: z.enum(['read-only', 'worker']) })
    .optional(),
  toolCallId: Id,
  turnId: Id,
});
export type HostChildOrigin = z.infer<typeof HostChildOriginSchema>;
/**
 * BST-1932: a child as its parent's sidebar shows it: a run in progress, a run
 * waiting on a person's answer, or no run in progress.
 */
export const HostChildStatusSchema = z.enum(['working', 'needs-input', 'idle']);
export type HostChildStatus = z.infer<typeof HostChildStatusSchema>;
/**
 * BST-1932: the host's notice that a thread's children changed status (a child
 * run started, paused for a person, was answered or ended). A client re-reads
 * `thread/children` for `threadId` only when told.
 */
export const HOST_CHILDREN_CHANGED = 'thread/children/changed';
export const HostChildrenChangedSchema = z.strictObject(Thread);
/** One settled background invocation delivered to its parent (BST-1932). */
export const HostChildDeliveryEntrySchema = z.strictObject({
  childRunId: Id,
  childThreadId: Id,
  /** A completed run typed into an idle child, not its delegated invocation. */
  followUp: z.literal(true).optional(),
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
/** A key a user supplies directly. Subscription OAuth is never a login payload. */
export type HostLoginCredential = Exclude<ProviderCredential, { readonly type: 'oauth' }>;
const LoginCredential = z.custom<HostLoginCredential>(
  (value) => isProviderCredential(value) && value.type !== 'oauth'
);
const Provider = { provider: Id };
/** A workspace root by its durable ID: the desktop's DB `roots.id`. */
const HookRoot = { rootId: Id };
/**
 * A root's trusted project hooks: its absolute path and the SHA-256 of
 * `<path>/.brainstrike/hooks.json`'s raw bytes. The host is the only writer.
 */
export const HostHookTrustSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type HostHookTrust = z.infer<typeof HostHookTrustSchema>;

/** Why observational memory waits for an observer it can run. */
export const HOST_OBSERVER_AWAITING_REASONS = [
  'keys-unknown',
  'model-not-eligible',
  'no-backend',
  'no-hosted-chat-provider',
] as const;
export type HostObserverAwaitingReason = (typeof HOST_OBSERVER_AWAITING_REASONS)[number];
const ObservationTokens = z.number().int().nonnegative();
/**
 * Observational memory as a run admission configures it. `active` carries the
 * thread's committed observation record, or null before the first observation.
 */
export const HostObservationalMemoryStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('off') }),
  z.strictObject({
    reason: z.enum(HOST_OBSERVER_AWAITING_REASONS),
    state: z.literal('awaiting-observer'),
  }),
  z.strictObject({
    record: z
      .strictObject({
        bufferedObservationTokens: ObservationTokens,
        messageTokenThreshold: z.number().int().positive(),
        observationTokenCount: ObservationTokens,
        pendingMessageTokens: ObservationTokens,
        totalTokensObserved: ObservationTokens,
      })
      .nullable(),
    state: z.literal('active'),
  }),
]);
export type HostObservationalMemoryState = z.infer<typeof HostObservationalMemoryStateSchema>;

/**
 * Host -> client: a UI action only the connected desktop client performs. The
 * one external opener for every host feature (OAuth sign-in, MCP authorization).
 */
export const CLIENT_OPEN_EXTERNAL = 'client/open-external';
export const ClientOpenExternalParamsSchema = z.strictObject({ url: z.url() });
export const ClientOpenExternalResultSchema = z.strictObject({ opened: z.literal(true) });

export const HOST_METHOD_SCHEMAS = {
  ...MCP_CONTENT_METHOD_SCHEMAS,
  ...MCP_PRESENTATION_METHOD_SCHEMAS,
  ...MCP_SETTINGS_METHOD_SCHEMAS,
  // auth/* is secret-bearing: process-local, never in HostCommandLedger, the log
  // or diagnostics. The host is the single writer and token holder.
  'auth/cancel': z.strictObject(Provider),
  'auth/clear': z.strictObject({}),
  'auth/connect': z.strictObject({
    ...Provider,
    method: z.enum(['device', 'loopback']).optional(),
  }),
  'auth/credential/delete': z.strictObject({ account: Id }),
  'auth/credential/set': z.strictObject({ account: Id, credential: LoginCredential }),
  'auth/disconnect': z.strictObject(Provider),
  'auth/login': z.strictObject({ ...Provider, credential: LoginCredential }),
  'auth/status': z.strictObject(Provider),
  'auth/verify': z.strictObject(Provider),
  /**
   * Restore a finished run's edited paths to their state before the run first
   * changed them (one entry, or every unreverted entry of the run). Refused
   * while the thread has an active run; `force` skips the conflict gate.
   */
  'checkpoint/revert': z.strictObject({
    ...Command,
    ...Run,
    entryId: Id.optional(),
    force: z.boolean().optional(),
  }),
  /**
   * Trust a root's project hooks at the hash its reviewer saw. The host
   * re-hashes the file and refuses a mismatch; a later edit needs a new trust.
   */
  'hooks/trust': z.strictObject({ ...HookRoot, ...HostHookTrustSchema.shape }),
  'hooks/trust/read': z.strictObject(HookRoot),
  /** Revoke a root's trust; removing the root revokes it too. */
  'hooks/untrust': z.strictObject(HookRoot),
  /** Provider availability: the host's configured keys, unreadable entries and env-file failures. */
  'host/status': z.strictObject({}),
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
    grant: PermissionGrant.optional(),
    interactionId: Id,
  }),
  'interaction/resume': z.strictObject({
    ...Command,
    ...Run,
    /** Only a network consent that also stood in for an approval carries one. */
    grant: PermissionGrant.optional(),
    interactionId: Id,
    resumeData: z.json(),
  }),
  /** Every thread's runs and costed provider calls, as Core folds its committed log. */
  'ledger/read': z.strictObject({}),
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
  /** Model metadata through the host's OpenRouter key; the client sends only the model id. */
  'providers/openrouter-model': z.strictObject({ model: Id }),
  /** The cheapest authenticated probe of one provider's stored or env credential. */
  'providers/verify': z.strictObject(Provider),
  /**
   * BST-1932: human input for a running child. The active run ends after its
   * step in flight, and the input starts the child's next run under these run
   * settings; only that run's end reports to the parent.
   */
  'run/input': z.strictObject({
    ...Command,
    ...Run,
    attachments: Attachments.optional(),
    configuration: z.record(z.string(), z.json()).optional(),
    modelId: Id,
    ...PlanMode,
    prompt: Id,
  }),
  'run/regenerate': z.strictObject({
    ...Command,
    ...Thread,
    configuration: z.record(z.string(), z.json()).optional(),
    modelId: Id,
    ...PlanMode,
    /** The original committed user message: its run/start command ID. */
    userMessageId: Id,
  }),
  'run/start': z.strictObject({
    ...Command,
    ...Thread,
    /** Images on the new user message, beside its prompt. */
    attachments: Attachments.optional(),
    configuration: z.record(z.string(), z.json()).optional(),
    modelId: Id,
    /** A committed run ID to follow, null for the thread root; omitted is the current tip. */
    parentMessageId: Id.nullable().optional(),
    ...PlanMode,
    prompt: Id,
  }),
  /**
   * End the active run gracefully at its next step boundary, after the step in
   * flight, so the user's steering message can start the next turn (BST-588).
   */
  'run/steer': z.strictObject({ ...Command, ...Run }),
  'run/stop': z.strictObject({ ...Command, ...Run }),
  /** A client verdict is always the user's; hook and revert labels are host-committed. */
  'run/verdict': z.strictObject({
    ...Command,
    ...Run,
    detail: RunVerdictDetail.optional(),
    source: z.literal('user'),
    verdict: RunVerdict,
  }),
  /** BST-1932: a thread's direct child threads; they are never in `thread/list`. */
  'thread/children': z.strictObject(Thread),
  /** Destructive Root lifecycle; the existing StateStore intent owns recovery. */
  'thread/delete': z.strictObject(Thread),
  'thread/list': z.strictObject({}),
  /**
   * Memory readiness for the thread's next run: the admission `run/start`
   * makes with these fields, released at once. Nothing is committed.
   */
  'thread/memory/read': z.strictObject({
    ...Thread,
    configuration: z.record(z.string(), z.json()).optional(),
    modelId: Id,
    ...PlanMode,
  }),
  'thread/read': z.strictObject({ ...Thread, fromSeq: Seq }),
  'thread/start': z.strictObject(Command),
  'thread/update': z
    .strictObject({ ...Command, ...Thread, ...ThreadPresentation })
    .refine((params) => Object.keys(params).length > 2, 'A thread update changes no field'),
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
  if (!(method.startsWith('mcp/') || method.startsWith('auth/'))) {
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
  /** The user-facing catalog ID (`brainstrike.readWorkspaceFile`), not the provider-sanitized name. */
  toolCatalogId: Id.optional(),
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
/** A prepared provider prompt's composition (the context popover's breakdown). */
export const HostPromptBreakdownSchema = z.strictObject({
  attachmentsCount: z.number().int().nonnegative(),
  historyMessagesTokens: z.number().int().nonnegative(),
  provenance: z.literal('heuristic'),
  systemInstructionsTokens: z.number().int().nonnegative(),
  toolDefinitionsProvenance: z.enum(['heuristic', 'measured']),
  toolDefinitionsTokens: z.number().int().nonnegative(),
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
  z.strictObject({
    ...RunFields,
    // Already redacted and bounded by the MCP discovery diagnostics.
    reason: z.string().min(1),
    serverId: Id,
    type: z.literal('mcp.tools.unavailable'),
  }),
  z.strictObject({ commandId: Id, type: z.literal('thread.started') }),
  z.strictObject({ origin: HostChildOriginSchema, type: z.literal('thread.started') }),
  z.strictObject({ ...ThreadPresentation, type: z.literal('thread.updated') }),
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
    /** The user message's images; a regeneration repeats its message's. */
    attachments: Attachments.optional(),
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
    ...PlanMode,
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
  /**
   * OM keeps one merged text per thread, so a branched thread's run receives
   * none. Gap 17: the legacy profile's resource observations were not
   * imported; that notice is committed once per root.
   */
  z.strictObject({
    type: z.literal('memory.observation.withheld'),
    ...RunFields,
    reason: z.enum(['branched-thread', 'legacy-resource-observations']),
  }),
  z.strictObject({
    type: z.literal('provider.request.prepared'),
    ...RunFields,
    accounting: z.json(),
    /** The prepared prompt's composition, for the context popover. */
    breakdown: HostPromptBreakdownSchema.optional(),
    modelId: Id,
    provider: Id,
  }),
  z.strictObject({
    type: z.literal('interaction.requested'),
    ...Action,
    /**
     * A code-execution approval's host-computed sandbox facts (reach, scratch
     * folder, reads, timeout), which the tool's arguments cannot carry. Shape:
     * assistant-contract's CodeExecutionApprovalContext; a consumer validates
     * it with isCodeExecutionApprovalContext before showing it.
     */
    executionContext: z.json().optional(),
    interactionId: Id,
    kind: z.enum(['approval', 'question', 'plan', 'network']),
    /** A permission approval's risk category, which its session grant names. */
    risk: RiskCategory.optional(),
  }),
  z.strictObject({
    type: z.literal('interaction.responded'),
    ...RunFields,
    /** BST-1932: the root's live policy, not a person, answered this approval. */
    by: z.literal('policy').optional(),
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
  /**
   * One provider attempt of a run leg ended in a recoverable class of failure.
   * `recovered` means a fresh attempt over the committed branch follows;
   * otherwise `refusal` says why not, and `run.finished` follows.
   */
  z.strictObject({
    type: z.literal('run.attempt'),
    ...RunFields,
    /** The attempt that ended, from 1, within this leg's `maxAttempts`. */
    attempt: z.number().int().positive(),
    detail: z.string().min(1),
    maxAttempts: z.number().int().positive(),
    reason: z.enum(['stalled', 'provider-error', 'empty-response', 'context-overflow']),
    recovered: z.boolean(),
    refusal: z.enum(['budget-exhausted', 'tool-parts', 'committed-output']).optional(),
    /** A stall's breadcrumb: which silence fired and how far the stream got. */
    stall: z
      .strictObject({
        lastPartType: Id.optional(),
        partsSeen: Seq,
        phase: z.enum(['awaiting-output', 'reasoning', 'streaming', 'tool-executing']),
      })
      .optional(),
  }),
  /**
   * Host-committed tool-output overlay (the legacy ToolProjectionRewriteEntry):
   * a later request replaces each call's result with its marker. A supersession
   * applies only while its superseding call is in the same request.
   */
  z.strictObject({
    type: z.literal('tool.projection.rewritten'),
    ...RunFields,
    rewrites: z
      .array(
        z.union([
          z.strictObject({
            kind: z.literal('prune'),
            markerText: z.string().regex(/\S/),
            supersededByToolCallId: z.null(),
            toolCallId: Id,
          }),
          z.strictObject({
            kind: z.literal('supersession'),
            markerText: z.string().regex(/\S/),
            supersededByToolCallId: Id,
            toolCallId: Id,
          }),
        ])
      )
      .min(1),
  }),
  /**
   * Host-committed overlay from the run that made it: later requests replace
   * these turns with `summary`. When a summarizer model ran, `modelId` and
   * `usage` are its side-call receipt, in `memory.usage`'s shape.
   */
  z.strictObject({
    type: z.literal('context.compacted'),
    ...RunFields,
    compactedRunIds: z.array(Id).min(1),
    kind: z.enum(['agentic', 'deterministic']),
    modelId: Id.optional(),
    reason: z.enum(['pre-request', 'context-overflow']),
    summary: z.string().min(1),
    usage: z.json().optional(),
  }),
  z.strictObject({
    type: z.literal('workspace.edit.recorded'),
    ...RunFields,
    after: HostFileIdentitySchema,
    /** First-touch baselines this edit captured for its run; later edits reuse them. */
    baselines: z.array(HostEditBaselineSchema),
    before: HostFileIdentitySchema,
    blobRefs: z.array(Sha256).optional(),
    entryId: Id,
    /** Rename source; `before` observes it, `after` observes the destination. */
    fromPath: WorkspaceRelativePath.optional(),
    op: HostWorkspaceEditOpSchema,
    path: WorkspaceRelativePath,
    rootId: Id,
    /** The admitted absolute root; revert revalidates it with the live root owner. */
    rootPath: Id,
    toolCallId: Id,
    toolId: Id,
  }),
  z.strictObject({
    type: z.literal('tool.state.updated'),
    ...RunFields,
    /** Tool-owned key, e.g. the task list or one canvas; the latest value per key wins. */
    key: Id,
    toolCallId: Id,
    value: z.json(),
  }),
  z.strictObject({
    type: z.literal('workspace.edit.reverted'),
    ...RunFields,
    commandId: Id,
    outcomes: z.array(HostEditRevertOutcomeSchema),
  }),
  /**
   * The run's workspace at a turn boundary, for its Changes review: its roots'
   * snapshots at the turn's start, and the same roots' at its end. `failure`
   * records a capture that failed as a whole (no roots were snapshotted).
   */
  z.strictObject({
    type: z.literal('workspace.snapshot.recorded'),
    ...RunFields,
    boundary: z.enum(['turn-start', 'turn-end']),
    failure: z.string().min(1).optional(),
    roots: z.array(HostTurnSnapshotSchema),
  }),
  /** Committed with the approval that granted it; the run's later decisions include it. */
  z.strictObject({ type: z.literal('permission.granted'), ...RunFields, grant: PermissionGrant }),
  /**
   * Context a lifecycle hook added for the model: a UserPromptSubmit hook's
   * for its run's instructions, or a PostToolUse hook's for one tool result.
   */
  z.strictObject({
    type: z.literal('hook.context'),
    ...RunFields,
    context: z.string().min(1),
    toolCallId: Id.optional(),
  }),
  /** Only the host commits labels; precedence is applied by projectRunVerdicts. */
  z.strictObject({
    type: z.literal('run.verdict'),
    ...RunFields,
    detail: RunVerdictDetail.optional(),
    source: z.enum(['edit_revert', 'hook', 'user']),
    verdict: RunVerdict,
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
  ...MCP_CONTENT_RESULT_SCHEMAS,
  ...MCP_PRESENTATION_RESULT_SCHEMAS,
  ...MCP_SETTINGS_RESULT_SCHEMAS,
  'auth/cancel': HostAuthStatusSchema,
  'auth/clear': z.strictObject({ cleared: z.boolean() }),
  'auth/connect': HostAuthStatusSchema,
  'auth/credential/delete': z.strictObject({ deleted: z.boolean() }),
  'auth/credential/set': z.strictObject({ stored: z.literal(true) }),
  'auth/disconnect': HostAuthStatusSchema,
  'auth/login': z.strictObject({ stored: z.literal(true) }),
  'auth/status': HostAuthStatusSchema,
  'auth/verify': HostAuthVerdictSchema,
  'checkpoint/revert': z.strictObject({ outcomes: z.array(HostEditRevertOutcomeSchema) }),
  'hooks/trust': z.strictObject({ trusted: z.literal(true) }),
  'hooks/trust/read': z.strictObject({ trust: HostHookTrustSchema.nullable() }),
  /** Whether a trust was revoked; false when the root had none. */
  'hooks/untrust': z.strictObject({ untrusted: z.boolean() }),
  // The renderer validates the availability payload strictly (use-assistant-availability).
  'host/status': z.record(z.string(), z.json()),
  'host/stop': z.strictObject({ outcome: z.literal('stopped'), rootReleased: z.literal(true) }),
  initialize: z.strictObject({
    hostVersion: Id,
    pid: z.number().int().positive(),
    protocolVersion: z.number().int().positive(),
    start: Id,
  }),
  'interaction/respond': z.strictObject({ accepted: z.literal(true) }),
  'interaction/resume': z.strictObject({ accepted: z.literal(true) }),
  'ledger/read': z.strictObject({ threads: z.array(HostLedgerThreadSchema) }),
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
  'providers/openrouter-model': z
    .unknown()
    .transform(
      (value): OpenRouterModelMetadataSnapshot => parseOpenRouterModelMetadataSnapshot(value)
    ),
  'providers/verify': z
    .unknown()
    .transform((value): ProviderVerificationSnapshot => parseProviderVerificationSnapshot(value)),
  'run/input': z.strictObject({ accepted: z.literal(true) }),
  'run/regenerate': z.strictObject({ runId: Id }),
  'run/start': z.strictObject({ runId: Id }),
  'run/steer': z.strictObject({ outcome: z.enum(['steering', 'already-terminal']) }),
  'run/stop': z.strictObject({ outcome: z.enum(['stopped', 'already-terminal']) }),
  'run/verdict': z.strictObject({ accepted: z.literal(true) }),
  'thread/children': z.strictObject({
    // Delegation order: each child with the origin its thread.started committed,
    // and its call sign, family colour and status, derived on every read.
    children: z.array(
      z.strictObject({
        ...Thread,
        callSign: z.string().min(1),
        color: z.string().min(1),
        origin: HostChildOriginSchema,
        status: HostChildStatusSchema,
      })
    ),
  }),
  'thread/delete': z.strictObject({
    deleted: z.literal(true),
    /** The thread and every child thread under it (BST-1932), all deleted. */
    threadIds: z.array(Id).min(1),
  }),
  'thread/list': z.strictObject({
    // Presentation fields never committed are absent.
    threads: z.array(z.strictObject({ ...Thread, ...ThreadPresentation })),
  }),
  // Not ready: the reason `run/start` would fail with; the observation needs an admission.
  'thread/memory/read': z.union([
    z.strictObject({
      admission: z.strictObject({ ready: z.literal(true) }),
      observational: HostObservationalMemoryStateSchema,
    }),
    z.strictObject({
      admission: z.strictObject({ ready: z.literal(false), reason: z.string().min(1) }),
    }),
  ]),
  'thread/read': z.strictObject({ rows: z.array(HostLogRowSchema) }),
  'thread/start': z.strictObject(Thread),
  'thread/update': z.strictObject({ accepted: z.literal(true) }),
  'thread/workspace/binding/read': z.strictObject({
    binding: ThreadWorkspaceBindingSchema.nullable(),
  }),
  'thread/workspace/binding/update': z.strictObject({ accepted: z.literal(true) }),
  'thread/workspace/read': z.strictObject({ snapshot: WorkspaceSnapshotSchema.nullable() }),
  'thread/workspace/set': z.strictObject({ accepted: z.literal(true) }),
} as const;
export type HostResults = { [M in HostMethod]: z.infer<(typeof HOST_RESULT_SCHEMAS)[M]> };
