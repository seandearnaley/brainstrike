import {
  ASSISTANT_TOOL_ACTION_ID_MAX_CHARS,
  type DelegatedToolActionIdentity,
  type DelegatedToolDecisionState,
  hasValidDelegatedDecisionState,
  hasValidDelegatedToolActionTarget,
  isDelegatedToolActionIdentity,
} from './delegated-tool-actions.js';
import type { ToolRiskCategory } from './tool-risk.js';

export const TOOL_APPROVAL_DATA_NAME = 'brainstrike.tool-approval';
export const TOOL_APPROVAL_RUN_CONFIG_KEY = 'brainstrikeToolApproval';

/**
 * Run ids and tool-call ids share the assistant transport's 512-character
 * identifier ceiling. Keeping the number here makes approval actions safe to
 * validate without importing the agent package back into this browser-safe
 * contract.
 */
export const ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS = ASSISTANT_TOOL_ACTION_ID_MAX_CHARS;

/**
 * Approval actions carry a display-only tool identity. Bound it to the same
 * transport identifier ceiling while allowing Brainstrike's namespaced tool
 * ids (which are not limited to the provider-facing 64-character name form).
 */
export const ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS = 512;

/**
 * Executor kinds / languages mirrored from the agent seam (`EXECUTOR_KINDS`,
 * `EXEC_LANGUAGES` in `packages/agent/src/code-execution.ts`). This
 * browser-safe contract cannot import the Node-only agent package, so the
 * literals are local — the same trade the approval-notice narrowers make.
 */
export type CodeExecutionExecutorKind = 'fence' | 'vm';
export type CodeExecutionLanguage = 'python' | 'javascript' | 'bash';

/**
 * Server-computed, display-only execution context for a code-execution
 * approval (BST-1070 design §2.2). NEVER model-supplied: the agent runtime
 * derives it from the same inputs the tool's execute path will use, the same
 * way `riskCategory` is stamped from `buildNativeToolRiskMap`. It travels in
 * THREE places — the approval chunk, the data-stream mapper's rebuilt data
 * part, and rediscovery's recompute — and the fail-safe for its absence is
 * that the card shows no fact rows and suppresses grant buttons rather than
 * guessing.
 */
export interface CodeExecutionApprovalContext {
  /** Effective `ExecPolicy.allowedDomains`. Empty = no network. */
  readonly allowedDomains: readonly string[];
  /** Explicit `ExecPolicy.allowRead` entries (absent in the policy ⇒ empty here). */
  readonly allowRead: readonly string[];
  /**
   * Writable entries BEYOND the per-call scratch folder (today always empty).
   * The scratch folder itself is minted by mkdtemp at execute time, after
   * approval, so its location travels as {@link scratchParentDir} rather than
   * as a fabricated not-yet-existing path in this list.
   */
  readonly allowWrite: readonly string[];
  /**
   * How the sandbox treats reads OUTSIDE `allowRead`. The OS fence is
   * `'permissive'` — sandboxed code can read broadly, with credential stores
   * always denied (see the fence's `ALWAYS_DENY_READ_PATHS`); a future VM
   * backend with granted-folder shares would be `'none'`. Card copy MUST key
   * on this field, never on `allowRead.length === 0`: an empty allow list
   * under a permissive default means "everything", not "nothing".
   */
  readonly defaultReadAccess: 'permissive' | 'none';
  readonly executorKind: CodeExecutionExecutorKind;
  readonly language: CodeExecutionLanguage;
  /**
   * Stable hash over every other field, computed by the agent runtime
   * (`computeExecutionContextFingerprint`). Today the context is a pure
   * function of the durable tool arguments plus build constants, and the card
   * is always computed by the same build/process that executes (live = same
   * process; reload = rediscovery recomputes), so there is no drift input for
   * an execute-time compare to catch — the enforcement half lands with the
   * workspace exec config that first introduces real drift (design §2.2).
   * Carried now so both sides of that future compare already exist.
   */
  readonly policyFingerprint: string;
  /**
   * The parent directory under which the per-call scratch folder
   * (`brainstrike-run-python-<random>`) is created. The exact folder is
   * minted by mkdtemp at execute time, AFTER approval, so the card can only
   * honestly name its location — never a precise path that does not exist yet.
   */
  readonly scratchParentDir: string;
  readonly timeoutMs: number;
}

const CODE_EXECUTION_APPROVAL_CONTEXT_KEYS = new Set<PropertyKey>([
  'allowedDomains',
  'allowRead',
  'allowWrite',
  'defaultReadAccess',
  'executorKind',
  'language',
  'policyFingerprint',
  'scratchParentDir',
  'timeoutMs',
]);

function isNonBlankStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  );
}

/**
 * Exact-shape guard for {@link CodeExecutionApprovalContext}. Unknown own keys
 * are rejected (the same wire discipline as `isAssistantToolApprovalAction`):
 * this object drives a security card, so a shape this code does not fully
 * understand must fall to the absent-context path (no fact rows, grants
 * suppressed), never render partially.
 */
export function isCodeExecutionApprovalContext(
  value: unknown
): value is CodeExecutionApprovalContext {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).every((key) => CODE_EXECUTION_APPROVAL_CONTEXT_KEYS.has(key)) &&
    [...CODE_EXECUTION_APPROVAL_CONTEXT_KEYS].every((key) => Object.hasOwn(value, key)) &&
    isNonBlankStringArray(value['allowedDomains']) &&
    isNonBlankStringArray(value['allowRead']) &&
    isNonBlankStringArray(value['allowWrite']) &&
    (value['defaultReadAccess'] === 'permissive' || value['defaultReadAccess'] === 'none') &&
    (value['executorKind'] === 'fence' || value['executorKind'] === 'vm') &&
    (value['language'] === 'python' ||
      value['language'] === 'javascript' ||
      value['language'] === 'bash') &&
    typeof value['policyFingerprint'] === 'string' &&
    value['policyFingerprint'].length > 0 &&
    typeof value['scratchParentDir'] === 'string' &&
    value['scratchParentDir'].length > 0 &&
    typeof value['timeoutMs'] === 'number' &&
    Number.isInteger(value['timeoutMs']) &&
    value['timeoutMs'] > 0
  );
}

export interface AssistantToolApprovalRequest {
  args?: unknown;
  continuationId?: string;
  delegation?: DelegatedToolActionIdentity;
  /**
   * Present only for code-execution tools (today: `brainstrike.runPython`);
   * absent everywhere else. See {@link CodeExecutionApprovalContext}.
   */
  executionContext?: CodeExecutionApprovalContext;
  /**
   * The DURABLE host leg (`brainstrike_assistant_thread_runs.id`) that streamed
   * this pause, stamped by the host at the same seam that stamps run events.
   * The notice copies it into its action echo, where the history topology
   * adapter resolves the suspended message's parent through the leg's
   * `turn_message_id` (BST-1163). Absent on a REDISCOVERED pause (its leg ended
   * at the restart) and on a pause whose turn belongs to a child continuation,
   * whose turn link is the continuation id rather than a root message.
   */
  hostRunId?: string;
  /**
   * The permission decision that caused the pause. Only `'ask'` is meaningful
   * here (an approval pause is, by definition, an `'ask'`); present so the UI can
   * say WHY the tool needs approval. Absent for a pause not driven by the
   * permission policy (e.g. an explicit global `requireToolApproval`).
   */
  policyDecision?: 'ask';
  resumeSchema?: unknown;
  /**
   * The risk bucket that resolved to `'ask'` for this tool (edit | execute | …),
   * surfaced so the approval notice can name the reason ("requires approval:
   * edit"). Absent when the pause was not driven by a permission policy.
   */
  riskCategory?: ToolRiskCategory;
  runId: string;
  toolCallId: string;
  toolName: string;
}

/**
 * An approval re-discovered from workflow storage after a restart/reload (via
 * `agent.listSuspendedRuns`). Extends the live-stream {@link
 * AssistantToolApprovalRequest} additively so the SAME notice + resume seam can
 * render it — the only additions are the suspend instant and an advisory
 * staleness flag (see D5: surface, never auto-decline).
 */
export interface RediscoveredToolApproval extends AssistantToolApprovalRequest {
  /** Present when the host has already admitted this exact delegated leaf decision. */
  readonly decisionState?: DelegatedToolDecisionState;
  /** True when older than BRAINSTRIKE_APPROVAL_STALE_MS (advisory only). */
  readonly stale: boolean;
  /** ISO-8601 instant the run suspended (AgentRun.suspendedAt). */
  readonly suspendedAt: string;
}

export interface SuspendedApprovalsResponse {
  readonly approvals: readonly RediscoveredToolApproval[];
}

export function isRediscoveredToolApproval(value: unknown): value is RediscoveredToolApproval {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    value['runId'].trim().length > 0 &&
    typeof value['toolCallId'] === 'string' &&
    value['toolCallId'].trim().length > 0 &&
    typeof value['toolName'] === 'string' &&
    value['toolName'].trim().length > 0 &&
    typeof value['suspendedAt'] === 'string' &&
    typeof value['stale'] === 'boolean' &&
    hasValidDelegatedDecisionState(value) &&
    hasValidDelegatedToolActionTarget(value)
  );
}

/**
 * The settled RESULT of a tool call the user declined at its approval gate
 * (`@mastra/core` 1.59 emits `tool-output-denied` for that leg, BST-1282).
 *
 * A decline is TERMINAL but it is NOT a failure: the tool never ran, so nothing
 * completed and nothing broke. Consumers must therefore render it as a stopped
 * outcome — never the green Completed a bare settled result would earn, and
 * never the destructive Failed chrome an error result would.
 *
 * It lives in this browser-safe contract, rather than being narrowed
 * structurally on each side, because BOTH ends must agree on the discriminator:
 * the producer is the agent package's Mastra stream mapper and the consumer is
 * the tool card in `@brainstrike/assistant-ui`.
 */
export const DECLINED_TOOL_RESULT_KIND = 'declined';
export const TOOL_CALL_DECLINED_MESSAGE =
  'The user declined this tool call, so it was not executed.';

export interface DeclinedToolCallResult {
  readonly kind: typeof DECLINED_TOOL_RESULT_KIND;
  /**
   * Human-readable statement of the DECISION only. Never carries tool
   * internals: the tool did not run, so there is nothing of its own to report.
   */
  readonly message: string;
  /** The user's own explanation, present only when they supplied one. */
  readonly reason?: string;
}

/** The same visible decision for live denial chunks and native persisted denials. */
export function createDeclinedToolCallResult(reason?: string): DeclinedToolCallResult {
  return {
    kind: DECLINED_TOOL_RESULT_KIND,
    message: TOOL_CALL_DECLINED_MESSAGE,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Structural guard for {@link DeclinedToolCallResult}. Extra keys are tolerated
 * (a settled result is display data and must survive additive evolution), but a
 * missing/blank `message` fails the guard — a card that showed a declined state
 * with no statement of the decision would be inventing the outcome.
 */
export function isDeclinedToolCallResult(value: unknown): value is DeclinedToolCallResult {
  return (
    isRecord(value) &&
    value['kind'] === DECLINED_TOOL_RESULT_KIND &&
    typeof value['message'] === 'string' &&
    value['message'].trim().length > 0
  );
}

export type AssistantToolApprovalDecision = 'approve' | 'decline';

export const TOOL_APPROVAL_ANSWERED_DATA_NAME = 'brainstrike.tool-approval-answered';

/**
 * A parked approval the HOST answered on the user's behalf, streamed on the
 * leg that answered it (BST-1723, settled 2026-09-14). Today the only reason
 * is a session grant: when the user allows a risk category for the session
 * while approving one call, every sibling background child parked on a tool
 * that category now allows is resumed in the same leg, and the notice for each
 * locks as "Allowed by session grant". Keyed like the notice it answers
 * (`getToolActionIdentityKey`), so the card finds it by scanning the thread.
 */
/**
 * Why the host answered a card without a user message on the thread:
 * `'session-grant'` — a lasting grant on a sibling's card answered it by
 * policy; `'user'` — the user's own decision was delivered into the running
 * leg (POST /assistant/decide), so no action message follows it.
 */
export type AssistantToolApprovalAnsweredReason = 'session-grant' | 'user';

export interface AssistantToolApprovalAnswered {
  readonly decision: AssistantToolApprovalDecision;
  readonly delegation?: DelegatedToolActionIdentity;
  readonly reason: AssistantToolApprovalAnsweredReason;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export function isAssistantToolApprovalAnswered(
  value: unknown
): value is AssistantToolApprovalAnswered {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate['decision'] === 'approve' || candidate['decision'] === 'decline') &&
    (candidate['reason'] === 'session-grant' || candidate['reason'] === 'user') &&
    typeof candidate['runId'] === 'string' &&
    typeof candidate['toolCallId'] === 'string' &&
    typeof candidate['toolName'] === 'string' &&
    (candidate['delegation'] === undefined ||
      isDelegatedToolActionIdentity(candidate['delegation']))
  );
}

export interface AssistantToolApprovalAction {
  action: AssistantToolApprovalDecision;
  continuationId?: string;
  delegation?: DelegatedToolActionIdentity;
  /**
   * The DURABLE host leg (`brainstrike_assistant_thread_runs.id`) whose turn
   * surfaced this pause, copied from the pause notice. Distinct from `runId`,
   * which is the NATIVE Mastra run the resume routes address: one host leg can
   * hold several native runs (a background wake-up mints another), and Mastra
   * mints its own ids, so the native id never matches a thread-run row. The
   * history topology adapter resolves the suspended message's durable parent
   * through this id's `turn_message_id` (BST-1163). Absent on a rediscovered
   * pause, whose host leg ended before the restart.
   */
  hostRunId?: string;
  runId: string;
  toolCallId: string;
  toolName?: string;
}

export type ToolApprovalRunConfigActionReadResult =
  | { readonly action: AssistantToolApprovalAction }
  | { readonly invalid: true };

const TOOL_APPROVAL_ACTION_OWN_KEYS = new Set<PropertyKey>([
  'continuationId',
  'delegation',
  'action',
  'hostRunId',
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

export function isAssistantToolApprovalAction(
  value: unknown
): value is AssistantToolApprovalAction {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).every((key) => TOOL_APPROVAL_ACTION_OWN_KEYS.has(key)) &&
    hasValidDelegatedToolActionTarget(value) &&
    Object.hasOwn(value, 'action') &&
    Object.hasOwn(value, 'runId') &&
    Object.hasOwn(value, 'toolCallId') &&
    (value['action'] === 'approve' || value['action'] === 'decline') &&
    isBoundedIdentifier(value['runId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS) &&
    isBoundedIdentifier(value['toolCallId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS) &&
    // Same own-and-bounded discipline as `toolName`: an inherited or blank host
    // leg would resolve the wrong turn anchor instead of failing visibly.
    (!('hostRunId' in value) ||
      (Object.hasOwn(value, 'hostRunId') &&
        isBoundedIdentifier(value['hostRunId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS))) &&
    (!('toolName' in value) ||
      (Object.hasOwn(value, 'toolName') &&
        isBoundedIdentifier(value['toolName'], ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS)))
  );
}

export function readToolApprovalRunConfigAction(
  runConfig: unknown
): ToolApprovalRunConfigActionReadResult | undefined {
  if (!isRecord(runConfig)) {
    return;
  }
  const custom = runConfig['custom'];
  if (!isRecord(custom)) {
    return;
  }
  const rawAction = custom[TOOL_APPROVAL_RUN_CONFIG_KEY];
  if (rawAction === undefined) {
    return;
  }
  if (!isAssistantToolApprovalAction(rawAction)) {
    return { invalid: true };
  }
  return { action: rawAction };
}
