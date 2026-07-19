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

import {
  ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS,
  ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS,
} from './tool-approval.js';

export const TOOL_SUSPEND_DATA_NAME = 'brainstrike.tool-suspend';
export const TOOL_SUSPEND_RUN_CONFIG_KEY = 'brainstrikeToolSuspend';

/**
 * The suspend-pause metadata surfaced to the renderer. `suspendPayload` is
 * tool-defined (a {@link SubmitPlanPayload} for submitPlan, an
 * {@link AskUserPayload} for askUser) and stays `unknown` on the wire — the UI
 * narrows it by `toolName`.
 */
export interface AssistantToolSuspendRequest {
  /** Optional JSON-schema echo of the tool's resumeSchema, for UX/debugging. */
  resumeSchema?: unknown;
  runId: string;
  /** Tool-defined pause payload (plan body / question+options). */
  suspendPayload?: unknown;
  toolCallId: string;
  toolName: string;
}

/**
 * The resume action appended by the suspend notice. `resumeData` is the
 * branch-specific shape ({@link SubmitPlanDecision} for submitPlan, an
 * {@link AskUserAnswer} for askUser) and crosses the wire as `unknown`; Mastra
 * validates it against the tool's `resumeSchema` on resume.
 */
export interface AssistantToolResumeAction {
  resumeData: unknown;
  runId: string;
  toolCallId: string;
  toolName?: string;
}

export type ToolResumeRunConfigActionReadResult =
  | { readonly action: AssistantToolResumeAction }
  | { readonly invalid: true };

const TOOL_RESUME_ACTION_OWN_KEYS = new Set<PropertyKey>([
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

/** Free-text/single-select resume with a string; multi-select with a string[]. */
export type AskUserAnswer = string | string[];
