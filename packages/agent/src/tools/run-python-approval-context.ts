/**
 * BST-1070: the server-computed execution context stamped onto a
 * `brainstrike.runPython` approval (design §2.2).
 *
 * The facts a user needs before approving — where the script can write, how
 * reads behave, that network is off, the effective timeout — are HOST-derived,
 * not model-supplied, so they cannot travel in the tool's input schema (the
 * model must never choose its own sandbox). This module derives them from the
 * same inputs `run-python-tool.ts`'s execute path uses, so the card and the
 * execution agree by construction:
 *
 * - live approvals: `makeApprovalRequiredChunks` stamps the chunk, and the
 *   data-stream mapper forwards the field into the aui-data part;
 * - rediscovered approvals: the desktop status endpoint recomputes it from the
 *   durable args, exactly where `riskCategory` is recomputed today.
 *
 * Deliberately import-light: node builtins + the zod schema + the contract
 * type. It is loaded by the stream mapper, which desktop suites import with
 * `node:fs` mocked — nothing here may touch the filesystem at module scope
 * (the lesson from BST-1067's fence-executor top-level import).
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import { NATIVE_TOOL_ID, requireNativeToolExecutionBudget } from '@brainstrike/assistant-contract';
import type { CodeExecutionApprovalContext } from '@brainstrike/assistant-contract/tool-approval';
import { RunPythonInputSchema } from './schemas';

/** Matches the display schema's documented default; the seam caps at MAX_EXEC_TIMEOUT_MS. */
export const RUN_PYTHON_DEFAULT_TIMEOUT_MS = requireNativeToolExecutionBudget(
  NATIVE_TOOL_ID.runPython
).defaultMs;

/**
 * Stable hash over every non-fingerprint field, sorted-key canonical JSON.
 * Display-context-derived, carries no secrets; it exists so an approval-time
 * snapshot and an execute-time recompute are COMPARABLE. Today both are the
 * same pure function of the durable args plus build constants and the card is
 * always computed by the process that executes, so there is no drift input for
 * an execute-time compare to catch — the enforcement half lands with the
 * workspace exec config that first introduces real drift (see the contract
 * field's doc comment). Adding a compare before then would be a guard whose
 * failure no test can provoke.
 */
export function computeExecutionContextFingerprint(
  fields: Omit<CodeExecutionApprovalContext, 'policyFingerprint'>
): string {
  const canonical = JSON.stringify({
    allowedDomains: [...fields.allowedDomains],
    allowRead: [...fields.allowRead],
    allowWrite: [...fields.allowWrite],
    defaultReadAccess: fields.defaultReadAccess,
    executorKind: fields.executorKind,
    language: fields.language,
    scratchParentDir: fields.scratchParentDir,
    timeoutMs: fields.timeoutMs,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Derives the display context for a `run_python` approval, or `undefined` when
 * `args` do not parse against the tool's OWN strict input schema — the
 * fail-safe path, where the card shows no fact rows and suppresses grant
 * buttons rather than describing a call it cannot read.
 *
 * Every value mirrors what `run-python-tool.ts` will actually do:
 * `allowedDomains` echoes the model's requested domains (empty = no network;
 * a non-empty list still requires the per-call Gate B escalation before any
 * socket opens — BST-1070), the only writable path is a fresh mkdtemp folder
 * under `os.tmpdir()` (minted at execute time, so only its PARENT is namable
 * here), reads are the fence's permissive default, and the timeout falls back
 * to {@link RUN_PYTHON_DEFAULT_TIMEOUT_MS}.
 */
export function resolveRunPythonExecutionContext(
  args: unknown
): CodeExecutionApprovalContext | undefined {
  const parsed = RunPythonInputSchema.safeParse(args);
  if (!parsed.success) {
    return;
  }
  const fields: Omit<CodeExecutionApprovalContext, 'policyFingerprint'> = {
    // Gate B (BST-1070): the domains the model requested — the approval card
    // shows "Wants to reach N domains" plus the forewarning that a separate
    // escalation follows; the escalation itself rides the suspension channel.
    allowedDomains: parsed.data.allowedDomains ?? [],
    allowRead: [],
    // Entries BEYOND the per-call scratch folder (today: none). The scratch
    // folder itself cannot be listed — mkdtemp mints it after approval — so
    // its location travels as scratchParentDir instead of a fabricated path.
    allowWrite: [],
    defaultReadAccess: 'permissive',
    executorKind: 'fence',
    language: 'python',
    scratchParentDir: os.tmpdir(),
    timeoutMs: parsed.data.timeoutMs ?? RUN_PYTHON_DEFAULT_TIMEOUT_MS,
  };
  return { ...fields, policyFingerprint: computeExecutionContextFingerprint(fields) };
}
