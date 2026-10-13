import type {
  AssistantToolApprovalRequest,
  CodeExecutionApprovalContext,
} from '@brainstrike/assistant-contract/tool-approval';
import { isCodeExecutionApprovalContext } from '@brainstrike/assistant-contract/tool-approval';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';

/*
 * run_python's strict argument narrowing and execution-context read, shared
 * by its structured preview (`approval-preview.tsx`) and the card's
 * grant-suppression policy (`resolveApprovalPreviewPolicy`). Component-free so
 * the preview file keeps its Fast Refresh boundary (react-refresh
 * `only-export-components`).
 */

const RUN_PYTHON_ARG_KEYS = new Set(['allowedDomains', 'code', 'timeoutMs']);
// Local literals mirroring the agent seam's MAX_EXEC_CODE_LENGTH /
// MAX_EXEC_TIMEOUT_MS (packages/agent/src/code-execution.ts). The UI package
// does not depend on @brainstrike/agent — the same trade the other narrowers
// in `approval-preview.tsx` make.
const RUN_PYTHON_MAX_CODE_CHARS = 1_000_000;
const RUN_PYTHON_MAX_TIMEOUT_MS = 600_000;
// Mirrors MAX_POLICY_ENTRIES / MAX_POLICY_DOMAIN_LENGTH. Domain SHAPE is NOT
// re-validated here — the seam's policyDomainSchema is authoritative and a
// second drifting regex would be a way to disagree with the thing that
// actually enforces it (design §2.5); this narrowing only bounds size.
const RUN_PYTHON_MAX_DOMAINS = 256;
const RUN_PYTHON_MAX_DOMAIN_CHARS = 253;

/** What a preview reads from an approval: its tool, arguments and host facts. */
export type ApprovalPreviewSubject = Pick<
  AssistantToolApprovalRequest,
  'args' | 'executionContext' | 'targetRoot' | 'toolName'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

interface RunPythonApprovalArgs {
  readonly allowedDomains?: readonly string[];
  readonly code: string;
  readonly timeoutMs?: number;
}

/**
 * Structural guard mirroring the agent-package `RunPythonInputSchema`
 * (strict: `code` + optional `timeoutMs` + optional `allowedDomains`, nothing
 * else). One deliberate display-side difference: an EMPTY `code` passes here
 * so the card can say "this script is empty" instead of a parse error — the
 * agent schema still rejects it at execute time. An unknown key (e.g. an
 * `unknownField` from a newer build) fails narrowing: a call carrying a field
 * this build does not understand must not be described as if it were
 * understood.
 */
export function narrowRunPythonArgs(value: unknown): RunPythonApprovalArgs | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !RUN_PYTHON_ARG_KEYS.has(key))) {
    return null;
  }
  const { allowedDomains, code, timeoutMs } = value;
  if (typeof code !== 'string' || code.length > RUN_PYTHON_MAX_CODE_CHARS) {
    return null;
  }
  if (
    allowedDomains !== undefined &&
    !(
      Array.isArray(allowedDomains) &&
      // [] is the OpenAI-strict-mode spelling of "no network" — valid.
      allowedDomains.length <= RUN_PYTHON_MAX_DOMAINS &&
      allowedDomains.every(
        (domain) =>
          typeof domain === 'string' &&
          domain.trim().length > 0 &&
          domain.length <= RUN_PYTHON_MAX_DOMAIN_CHARS
      )
    )
  ) {
    return null;
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > RUN_PYTHON_MAX_TIMEOUT_MS)
  ) {
    return null;
  }
  return {
    ...(Array.isArray(allowedDomains) ? { allowedDomains: allowedDomains as string[] } : {}),
    code,
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  };
}

/**
 * The validated execution context for a code-execution approval, or `null`.
 * The wire value is untrusted `unknown`; a shape the exact guard does not
 * fully understand falls to the absent-context path (no fact rows, grants
 * suppressed) rather than rendering partially.
 */
export function readRunPythonExecutionContext(
  approval: ApprovalPreviewSubject
): CodeExecutionApprovalContext | null {
  const context: unknown = approval.executionContext;
  return isCodeExecutionApprovalContext(context) ? context : null;
}

/**
 * Whether the parent should suppress the grant buttons for this approval, or
 * `null` for tools with no preview-policy opinion (every non-code-execution
 * tool — completely unaffected). Decided in the PARENT, from the same inputs
 * the preview narrows, because the suppression has to reach the button row the
 * parent renders — a preview that returned `{ node, suppressGrants }` would be
 * easy to ignore (BST-1070 design §2.1).
 */
export function resolveApprovalPreviewPolicy(
  approval: ApprovalPreviewSubject
): { readonly suppressGrants: boolean } | null {
  if (approval.toolName !== NATIVE_TOOL_ID.runPython) {
    return null;
  }
  const suppressGrants =
    narrowRunPythonArgs(approval.args) === null || readRunPythonExecutionContext(approval) === null;
  return { suppressGrants };
}
