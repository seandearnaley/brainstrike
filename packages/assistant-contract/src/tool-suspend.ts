import {
  type DelegatedToolActionIdentity,
  hasValidDelegatedToolActionTarget,
} from './delegated-tool-actions.js';
/**
 * Tool SUSPEND transport contract — the wire vocabulary for the two suspending
 * native tools (`submitPlan`, `askUser`). This PARALLELS the tool-APPROVAL
 * transport (`tool-approval.ts`) rather than overloading it: an approval pause
 * resumes with `{action:'approve'|'decline'}` and a fixed server verb, whereas a
 * suspend pause resumes with ARBITRARY `resumeData` (a plan decision, or a
 * free-text/multi-select answer) validated by Mastra against each tool's own
 * `resumeSchema`, and resumes via `agent.resumeStream(resumeData, {runId, toolCallId})`.
 *
 * Cross-reload note: the `brainstrike.tool-suspend` data part is transient
 * (aui-data, not persisted) — identical to the approval data part. In-session
 * resume works today; cross-reload resume waits on the separate
 * `listSuspendedRuns` rehydration feature. Every field of
 * {@link AssistantToolResumeAction} is recoverable from
 * `listSuspendedRuns().runs[].toolCalls[]`, so the resume path stays stateless
 * and forward-compatible with it.
 */

import { NATIVE_TOOL_ID } from './native-tool-catalog.js';
import type { AssistantRunEventKind } from './run-events.js';
import {
  ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS,
  ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS,
  type SuspendedApprovalsResponse,
} from './tool-approval.js';

export const TOOL_SUSPEND_DATA_NAME = 'brainstrike.tool-suspend';
export const TOOL_SUSPEND_RUN_CONFIG_KEY = 'brainstrikeToolSuspend';

/**
 * The suspending tools whose `resumeSchema` has a REGISTERED typed suspension UI
 * (`AssistantToolSuspendNotice` branches on exactly these ids). This is the
 * single source of truth for "can this pause be answered by THIS build?" — the
 * agent stream mapper records a visible, durable rejection for a pause from any
 * other tool (never a silent inert card), and the renderer shows the matching
 * dead-end notice with a dismiss action. The rejection is deliberately
 * NON-terminal: the Mastra workflow snapshot is already persisted, so the run
 * stays suspended and a build that later registers the tool can still resume it.
 *
 * Adding a suspending tool means: register its typed UI branch AND add its id
 * here. Adding the id alone re-creates the silent dead end this list exists to
 * prevent; `SUSPENDING_NATIVE_TOOL_IDS` (plan-mode gate) derives from this list
 * so the two cannot drift.
 */
export const REGISTERED_SUSPEND_RESUME_TOOL_IDS = [
  NATIVE_TOOL_ID.askUser,
  // BST-1070 Gate B: run_python's network escalation rides the suspension
  // channel (per-call, argument-aware, structurally ungrantable). Registered
  // here means the escalation card is the typed resume UI; plan mode still
  // OMITS the tool on its execute risk (BST-1073 — a suspend schema is not an
  // admission ticket).
  NATIVE_TOOL_ID.runPython,
  NATIVE_TOOL_ID.submitPlan,
] as const;

export type RegisteredSuspendResumeToolId = (typeof REGISTERED_SUSPEND_RESUME_TOOL_IDS)[number];

const REGISTERED_SUSPEND_RESUME_TOOL_ID_SET: ReadonlySet<string> = new Set(
  REGISTERED_SUSPEND_RESUME_TOOL_IDS
);

/**
 * True when `toolName` names a suspending tool with a registered typed resume
 * UI. The check is on the CLIENT-FACING name form (the dotted canonical id the
 * stream chunk and the notice both use), so mapper and renderer agree.
 */
export function hasRegisteredSuspendResumeUi(
  toolName: string
): toolName is RegisteredSuspendResumeToolId {
  return REGISTERED_SUSPEND_RESUME_TOOL_ID_SET.has(toolName);
}

/**
 * The DURABLE run-event kind recorded when a suspending tool pauses a run this
 * build has no registered resume UI for. Its own kind on purpose:
 *
 * - `RUN_LEDGER_AGGREGATION_SQL` counts `tool.completed`/`tool.failed` as tool
 *   calls and `tool.failed` as failures. No tool ran here and none failed, and
 *   because the run deliberately STAYS suspended, a build that later registers
 *   the tool resumes the same `toolCallId` and emits the real `tool.completed`
 *   — reusing `tool.failed` would both invent a failure and double-count the
 *   one call, permanently.
 * - `collectToolDurations` and the timeline's `tool.started` resolution both
 *   close a tool call out on `tool.completed`/`tool.failed`. Closing this one
 *   out would contradict `runStillSuspended: true` in the event's own metadata.
 *
 * It IS in `isAlwaysVisibleRunEvent`, but NOT because the notice is lost on
 * reload — since BST-1084 `appendSuspendedPauseMessages` re-appends the
 * transient `brainstrike.tool-suspend` notice for pauses that are STILL
 * suspended. What that notice cannot be is IN the transcript: it is a synthetic
 * message appended at the END of the thread, and it exists only while the pause
 * is pending. This row is the in-transcript record, at the point the run
 * actually stopped, and the only thing that outlives the pause being answered
 * or discarded.
 */
export const UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND =
  'tool.resume.unsupported' satisfies AssistantRunEventKind;

/**
 * The suspend-pause metadata surfaced to the renderer. `suspendPayload` is
 * tool-defined (a {@link SubmitPlanPayload} for submitPlan, an
 * {@link AskUserPayload} for askUser) and stays `unknown` on the wire — the UI
 * narrows it by `toolName`.
 */
export interface AssistantToolSuspendRequest {
  delegation?: DelegatedToolActionIdentity;
  /** Optional JSON-schema echo of the tool's resumeSchema, for UX/debugging. */
  resumeSchema?: unknown;
  runId: string;
  /** Tool-defined pause payload (plan body / question+options). */
  suspendPayload?: unknown;
  toolCallId: string;
  toolName: string;
}

/**
 * A suspend pause re-discovered from workflow storage after a restart/reload
 * (BST-1084), via the same `listSuspendedRuns` discovery the approval path
 * uses. Extends the live-stream {@link AssistantToolSuspendRequest} ADDITIVELY
 * — the same notice + resume seam renders it — with the suspend instant and an
 * advisory staleness flag, mirroring {@link RediscoveredToolApproval} exactly
 * (surface, never auto-answer). `suspendPayload` is recovered from the durable
 * snapshot (Mastra's `AgentRunToolCall.suspendPayload`), so a rediscovered
 * plan/question renders its real content, not a placeholder.
 */
export interface RediscoveredToolSuspend extends AssistantToolSuspendRequest {
  /**
   * ADVISORY resumability flag. The desktop endpoint only ever writes the
   * literal `false` (no registered resume UI in this build), mirroring the
   * live chunk's narrowing-only-to-false contract — but the renderer
   * dispatches on `toolName`, never on this field, so the guard below does
   * NOT validate it: rejecting an otherwise-valid pause over an unrecognized
   * advisory value would re-create the silent stranding this contract exists
   * to remove (#2223 review).
   */
  readonly resumeSupported?: boolean;
  /** True when older than BRAINSTRIKE_APPROVAL_STALE_MS (advisory only). */
  readonly stale: boolean;
  /** ISO-8601 instant the run suspended (AgentRun.suspendedAt). */
  readonly suspendedAt: string;
}

/**
 * The `/assistant/suspended-runs` payload once suspend rediscovery ships:
 * the approvals array (unchanged) plus the rediscovered suspend pauses.
 * ADDITIVE — a client that only knows {@link SuspendedApprovalsResponse}
 * ignores `suspends` and loses nothing it had.
 */
export interface SuspendedRunsResponse extends SuspendedApprovalsResponse {
  readonly suspends?: readonly RediscoveredToolSuspend[];
}

export function isRediscoveredToolSuspend(value: unknown): value is RediscoveredToolSuspend {
  return (
    isRecord(value) &&
    isBoundedIdentifier(value['runId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS) &&
    isBoundedIdentifier(value['toolCallId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS) &&
    isBoundedIdentifier(value['toolName'], ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS) &&
    typeof value['suspendedAt'] === 'string' &&
    typeof value['stale'] === 'boolean' &&
    hasValidDelegatedToolActionTarget(value)
  );
}

/**
 * The resume action appended by the suspend notice. `resumeData` is the
 * branch-specific shape ({@link SubmitPlanDecision} for submitPlan, an
 * {@link AskUserResumeData} envelope for askUser — a bare {@link AskUserAnswer}
 * only from a run suspended before the envelope migration) and crosses the wire
 * as `unknown`; Mastra validates it against the tool's `resumeSchema` on resume.
 */
export interface AssistantToolResumeAction {
  delegation?: DelegatedToolActionIdentity;
  resumeData: unknown;
  runId: string;
  toolCallId: string;
  toolName?: string;
}

export type ToolResumeRunConfigActionReadResult =
  | { readonly action: AssistantToolResumeAction }
  | { readonly invalid: true };

const TOOL_RESUME_ACTION_OWN_KEYS = new Set<PropertyKey>([
  'delegation',
  'resumeData',
  'runId',
  'toolCallId',
  'toolName',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isBoundedIdentifier(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxChars;
}

/**
 * True when `value` is a structurally valid {@link AssistantToolResumeAction}:
 * exact own transport keys, bounded non-empty `runId`/`toolCallId` strings, an
 * OPTIONAL bounded non-empty `toolName`, and an own `resumeData` key. Its value
 * may be anything — a string, an array, `null`, or an object — because each
 * tool's resumeSchema defines it.
 */
export function isAssistantToolResumeAction(value: unknown): value is AssistantToolResumeAction {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).every((key) => TOOL_RESUME_ACTION_OWN_KEYS.has(key)) &&
    hasValidDelegatedToolActionTarget(value) &&
    Object.hasOwn(value, 'resumeData') &&
    Object.hasOwn(value, 'runId') &&
    Object.hasOwn(value, 'toolCallId') &&
    isBoundedIdentifier(value['runId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS) &&
    isBoundedIdentifier(value['toolCallId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS) &&
    (!('toolName' in value) ||
      (Object.hasOwn(value, 'toolName') &&
        isBoundedIdentifier(value['toolName'], ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS)))
  );
}

/**
 * Read the suspend resume action from a run-config `custom` bag. Returns
 * `undefined` when absent (a normal turn), `{ invalid: true }` when present but
 * malformed (surfaced as a 400, never coerced — no-silent-fallbacks), and
 * `{ action }` when valid. Mirrors {@link readToolApprovalRunConfigAction}.
 */
export function readToolResumeRunConfigAction(
  runConfig: unknown
): ToolResumeRunConfigActionReadResult | undefined {
  if (!isRecord(runConfig)) {
    return;
  }
  const custom = runConfig['custom'];
  if (!isRecord(custom)) {
    return;
  }
  const rawAction = custom[TOOL_SUSPEND_RUN_CONFIG_KEY];
  if (rawAction === undefined) {
    return;
  }
  if (!isAssistantToolResumeAction(rawAction)) {
    return { invalid: true };
  }
  return { action: rawAction };
}

// ── Per-tool payload contracts (single source of truth for UI + tools) ──

export interface SubmitPlanStep {
  detail?: string;
  title: string;
}

export interface SubmitPlanPayload {
  overview: string;
  risks?: string;
  steps: SubmitPlanStep[];
  title: string;
  verification?: string;
}

/**
 * The decision resumed into a suspended `submitPlan` call. Adopts the Mastra
 * builtin `SubmitPlanResumeData` vocab (`action: 'approved'|'rejected'` +
 * optional `feedback`) so a future `listSuspendedRuns`/AgentController path stays
 * wire-compatible.
 */
export interface SubmitPlanDecision {
  action: 'approved' | 'rejected';
  feedback?: string;
}

export interface AskUserOption {
  description?: string;
  label: string;
}

export type AskUserSelectionMode = 'single_select' | 'multi_select';

export interface AskUserPayload {
  options?: AskUserOption[];
  question: string;
  selectionMode?: AskUserSelectionMode;
}

/** Free-text/single-select answers are a string; multi-select a string[]. */
export type AskUserAnswer = string | string[];

/**
 * The resume envelope for `askUser`. An OBJECT on purpose: under @mastra/core
 * 1.56+ the suspend-resume transport must attach the `approved: true` rider to
 * an ask-gated tool's resume, and the rider only attaches to plain-object
 * payloads (`createToolResumeIteratorFromRuntime`, agent-streaming.ts) — a bare
 * string/array resume left ask-gated askUser answers exposed to the framework's
 * denial. The bare {@link AskUserAnswer} is the LEGACY pre-envelope shape: the
 * tool still accepts it so runs suspended before the migration remain
 * resumable, but the suspend notice only ever sends this envelope.
 */
export interface AskUserResumeData {
  answer: AskUserAnswer;
}

/**
 * The Gate A approval pause payload (BST-1097). `run_python` raises its own
 * approval gate from INSIDE execute() via Mastra's in-tool approval
 * suspension — `suspend({ kind: 'approval' }, { requireToolApproval: true })`
 * — because the per-tool `requireApproval` flag is incompatible with a tool
 * that also suspends (Mastra re-checks the flag on the Gate B resume leg and
 * denies a resume whose data has no `approved` key). That suspension emits
 * the ORDINARY `tool-call-approval` chunk, so the existing approval card,
 * grant surface, and approve/decline transport are unchanged; this payload
 * exists only to satisfy the tool's own suspendSchema validation and NEVER
 * reaches the suspend notice. The resume shape for Gate A is Mastra's own
 * `{ approved: boolean }` (what `approveToolCall`/`declineToolCall` send).
 */
export interface RunPythonApprovalSuspendPayload {
  readonly kind: 'approval';
}

/**
 * The Gate B network-escalation pause payload (BST-1070 design §3): built
 * inside `run_python`'s execute() from the LIVE resolved policy, so the
 * domains shown are the domains used, by construction. Never empty — an
 * empty-domain call runs without suspending.
 */
export interface RunPythonNetworkSuspendPayload {
  /** The exact ExecPolicy.allowedDomains the script will get. Never empty. */
  readonly allowedDomains: readonly string[];
  readonly kind: 'network';
}

/** Every payload `run_python` can suspend with (discriminated on `kind`). */
export type RunPythonSuspendPayload =
  | RunPythonApprovalSuspendPayload
  | RunPythonNetworkSuspendPayload;

/**
 * Resumed into the suspended `run_python` call. Deny is expressible; "run
 * offline instead" deliberately is NOT (design §3.3 rejected it: exit 0 with
 * silently missing data is a wrong result dressed as a stronger sandbox).
 * Anything that does not narrow to this shape is treated as DENY by the tool
 * — a schema drift must never become a silent network grant.
 */
export interface RunPythonNetworkDecision {
  readonly action: 'allow' | 'deny';
}
