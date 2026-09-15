/**
 * The LIVE approval gate (settled 2026-09-15, see assistant-runtime.md
 * PERMISSION ENGINE and assistant-subagents.md "SESSION GRANT STOPS ASKING").
 *
 * Mastra decides whether a tool call suspends for approval from the run-wide
 * `requireToolApproval` (boolean or per-call predicate) OR-ed with the
 * tool's own `requireApproval` flag (`agent-DsRUDsS_.js:26436`). The
 * permission gate used to clone every `'ask'` tool with that flag, so a
 * live "Allow reads this session" could only answer a pause AFTER the child
 * had already suspended: 70 suspensions, 70 cards and 70 resumes for reads
 * the user had allowed (GLM run, 2026-09-15). The flag is gone; this
 * predicate is now the ONLY thing that decides suspension, on the root's
 * legs and on every child call, and it reads the leg's remembered grant on
 * every evaluation.
 */
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { isApprovalExemptInternalTool } from './internal-approval-exempt-tools';
import {
  type PermissionAskToolMetadata,
  resolveSelfApprovalDecision,
} from './permission-tool-gate';
import type { ApprovalGate } from './runtime-assembly/stream-options';

export interface ApprovalGateSource {
  /** The ask set of THIS agent (the root's, or a child's own re-gated set). */
  readonly askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  readonly permissionEnforced: boolean;
  /** The lasting grant a live decision delivered into this leg, read per call. */
  readonly remembered: () => PermissionToolGateSnapshot | undefined;
  /** Registered (sanitized) id → original tool name. */
  readonly toolNameMap: ReadonlyMap<string, string>;
}

export interface RuntimeApprovalGate {
  /** True when this agent has ask tools — the only reason to hand Mastra a gate at all. */
  readonly gated: boolean;
  /** Mastra's per-call `requireToolApproval` predicate. */
  readonly requiresApproval: (call: { readonly toolName: string }) => boolean;
}

/**
 * "Allowed now" under a FRESH snapshot a decision carried: the same resolver
 * the gate itself runs, over the registered tool names. Moved here from
 * background-granted-approvals.ts so the gate and the parked-sibling answer
 * cannot disagree about what a grant allows.
 */
export function allowedBySnapshot(
  snapshot: PermissionToolGateSnapshot,
  toolNameMap: ReadonlyMap<string, string>
): (registeredToolName: string) => boolean {
  return (toolName) => {
    const original = toolNameMap.get(toolName);
    return original !== undefined && resolveSelfApprovalDecision(snapshot, original) === 'allow';
  };
}

export function createApprovalGate(source: ApprovalGateSource): RuntimeApprovalGate {
  const requiresApproval = ({ toolName }: { readonly toolName: string }): boolean => {
    if (isApprovalExemptInternalTool(toolName) || !source.askTools.has(toolName)) {
      return false;
    }
    const remembered = source.remembered();
    if (remembered === undefined) {
      return true;
    }
    return !allowedBySnapshot(remembered, source.toolNameMap)(toolName);
  };
  return { gated: source.askTools.size > 0, requiresApproval };
}

/**
 * What a leg hands Mastra as `requireToolApproval`.
 *
 * - caller set a function or `false` → unchanged.
 * - caller set nothing → the live predicate when the agent has ask tools,
 *   otherwise nothing (a run with no ask tools keeps parallel tool calls,
 *   `agent-DsRUDsS_.js:24053`).
 * - caller set `true` (the approval-resume API's request): an explicit
 *   GLOBAL approval only when NO policy was enforced and the ask set is
 *   empty — gate every non-internal tool, the pre-permission-engine
 *   behaviour. Otherwise the live predicate: under an enforced policy an
 *   empty ask set is the all-allowed posture ("Allow all tools this
 *   session") and the predicate gates nothing.
 */
export function resolveRequireToolApproval(
  requested: ApprovalGate | undefined,
  gate: RuntimeApprovalGate,
  permissionEnforced: boolean
): ApprovalGate | undefined {
  if (typeof requested === 'function' || requested === false) {
    return requested;
  }
  if (requested === undefined) {
    return gate.gated ? gate.requiresApproval : undefined;
  }
  if (!(gate.gated || permissionEnforced)) {
    return ({ toolName }: { toolName: string }): boolean => !isApprovalExemptInternalTool(toolName);
  }
  return gate.requiresApproval;
}
