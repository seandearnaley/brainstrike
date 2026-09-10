import type { ToolRiskCategory } from './tool-risk.js';

export const TOOL_APPROVAL_DATA_NAME = 'brainstrike.tool-approval';
export const TOOL_APPROVAL_RUN_CONFIG_KEY = 'brainstrikeToolApproval';

/**
 * Run ids and tool-call ids share the assistant transport's 512-character
 * identifier ceiling. Keeping the number here makes approval actions safe to
 * validate without importing the agent package back into this browser-safe
 * contract.
 */
export const ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS = 512;

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
  /**
   * Present only for code-execution tools (today: `brainstrike.runPython`);
   * absent everywhere else. See {@link CodeExecutionApprovalContext}.
   */
  executionContext?: CodeExecutionApprovalContext;
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
    typeof value['stale'] === 'boolean'
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

export interface AssistantToolApprovalAction {
  action: AssistantToolApprovalDecision;
  runId: string;
  toolCallId: string;
  toolName?: string;
}

export type ToolApprovalRunConfigActionReadResult =
  | { readonly action: AssistantToolApprovalAction }
  | { readonly invalid: true };

const TOOL_APPROVAL_ACTION_OWN_KEYS = new Set<PropertyKey>([
  'action',
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
    Object.hasOwn(value, 'action') &&
    Object.hasOwn(value, 'runId') &&
    Object.hasOwn(value, 'toolCallId') &&
    (value['action'] === 'approve' || value['action'] === 'decline') &&
    isBoundedIdentifier(value['runId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS) &&
    isBoundedIdentifier(value['toolCallId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS) &&
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
