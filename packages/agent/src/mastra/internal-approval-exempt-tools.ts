/**
 * Mastra-INTERNAL tools that must never prompt for user approval.
 *
 * These are injected by `@mastra/memory` (working-memory bookkeeping), not by the
 * Brainstrike tool map, so the permission gate never classifies them. They matter
 * only on the approval-RESUME leg, which passes Mastra's run-wide
 * `requireToolApproval: true` (required by the resume API). That blanket flag
 * would otherwise suspend EVERY tool call on the resumed run — including
 * `updateWorkingMemory` — surfacing a spurious approval prompt for internal
 * memory maintenance (the D4 defect).
 *
 * Canonical ids verified against the installed @mastra/memory 1.26.0
 * (`UPDATE_WORKING_MEMORY_TOOL_NAME = 'updateWorkingMemory'`,
 * `SET_WORKING_MEMORY_TOOL_NAME = 'setWorkingMemory'` — both unchanged from
 * the 1.22.1 baseline) and its VNext rename to `setWorkingMemory`
 * (docs-memory-working-memory.md). The only other memory-injected tool,
 * `recall` (OM retrieval), predates this range and is deliberately NOT
 * exempt — it reads workspace-derived content, so gating it on the resumed
 * leg is acceptable posture, and it was equally un-exempt at 1.22.1.
 * `__tests__/internal-approval-exempt-tools.guard.spec.ts` re-checks these
 * names against the INSTALLED @mastra/memory dist so a rename fails at the
 * next bump instead of silently prompting for approval on every resume (D4).
 */
const MASTRA_INTERNAL_APPROVAL_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'updateWorkingMemory',
  'setWorkingMemory',
]);

/**
 * True when a tool call is Mastra-internal memory bookkeeping that must execute
 * without an approval prompt on the run-wide-gated resume leg.
 */
export function isApprovalExemptInternalTool(toolName: string): boolean {
  return MASTRA_INTERNAL_APPROVAL_EXEMPT_TOOLS.has(toolName);
}
