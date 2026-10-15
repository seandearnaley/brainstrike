/**
 * The LIVE approval gate (settled 2026-09-15, see assistant-runtime.md
 * PERMISSION ENGINE and assistant-subagents.md "SESSION GRANT STOPS ASKING").
 *
 * Mastra decides whether a tool call suspends for approval from the run-wide
 * `requireToolApproval` OR-ed with the tool's own `requireApproval` flag
 * (`agent-DsRUDsS_.js:26436`), and a per-tool `needsApprovalFn` overrides
 * both (`:26437-26444`, evaluated on EVERY call). The permission gate used to
 * clone every `'ask'` tool with a STATIC `requireApproval: true`, so a live
 * "Allow reads this session" could only answer a pause AFTER the child had
 * already suspended: 70 suspensions, 70 cards and 70 resumes for reads the
 * user had allowed (GLM run, 2026-09-15).
 *
 * Now the clone carries the public FUNCTION form of the flag
 * (`dist/tools/types.d.ts:551`): `CoreToolBuilder.build()` turns it into
 * `requireApproval: true` + `needsApprovalFn` (`utils-C9npriyv.js:684-686`),
 * copied once per stream call (`agent-DsRUDsS_.js:34955`), and Mastra calls
 * that function on every tool call — so a grant remembered on this channel
 * lifts a mid-stream child on its very next call, and the per-step
 * concurrency classification (`:24054-24064`, which reads the boolean) is
 * exactly what the static flag gave it. No run-wide predicate is ever
 * synthesized: a truthy run-wide gate would force concurrency 1 on every
 * step (`:24054`). `createApprovalGate` is the single decision point; the
 * clone (`applyLiveApprovalGate`) only forwards to it.
 */
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import {
  type PermissionAskToolMetadata,
  resolveSelfApprovalDecision,
} from '../permissions/permission-tool-gate';
import { isApprovalExemptInternalTool } from './internal-approval-exempt-tools';
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

/**
 * Clone every kept ask tool with the FUNCTION form of `requireApproval` that
 * forwards to `gate.requiresApproval` on each call (by the registered name the
 * map is keyed by; the gate resolves the original name through `toolNameMap`).
 * Non-ask tools are returned by reference. Mirrors `applyToolGuards`' clone:
 * keep the prototype (a Mastra `Tool` instance) and every own descriptor, then
 * set the one field. An ask id absent from the map throws — a kept ask tool
 * that escaped the clone would run unprompted (a security bug, never a
 * fallback).
 */
export function applyLiveApprovalGate<TMap extends Record<string, unknown>>(
  tools: TMap,
  askToolIds: ReadonlySet<string>,
  gate: RuntimeApprovalGate
): TMap {
  const gated: Record<string, unknown> = { ...tools };
  for (const sanitizedId of askToolIds) {
    const tool = tools[sanitizedId];
    if (!tool || typeof tool !== 'object') {
      throw new Error(`Ask tool ${sanitizedId} is not in the gated tool map.`);
    }
    const cloned = Object.create(Object.getPrototypeOf(tool)) as Record<string, unknown>;
    Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));
    cloned['requireApproval'] = (): boolean => gate.requiresApproval({ toolName: sanitizedId });
    gated[sanitizedId] = cloned;
  }
  return gated as TMap;
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
 * What the APPROVAL leg hands Mastra as `requireToolApproval` when the caller
 * set one (the resume API passes `true`; the initial leg passes the caller's
 * option through untouched and never calls this — see attempt-legs.ts).
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
