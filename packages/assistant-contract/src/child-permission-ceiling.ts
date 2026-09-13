import {
  type PermissionDecision,
  type PermissionToolGateSnapshot,
  resolvePermissionDecision,
} from './permission-policy.js';
import type { ToolRiskCategory } from './tool-risk.js';

const risks = ['read', 'edit', 'execute', 'mcp'] as const;

/**
 * The admitted snapshot contributes ONLY its denies; every other decision follows
 * the live root policy. A root grant made after admission (a session grant, a
 * per-tool "Always allow", yolo) therefore lifts an admitted `ask`, and a later
 * root reduction (`allow` → `ask`/`deny`) still applies. Before this rule the
 * combination was a symmetric "stricter wins", which froze every admitted `ask`
 * and produced the 2026-09-12 readWorkspaceDirectory approval loop: 87 pauses on
 * one child tree that no grant could end.
 */
const combine = (admitted: PermissionDecision, current: PermissionDecision): PermissionDecision =>
  admitted === 'deny' ? 'deny' : current;

function decision(
  snapshot: PermissionToolGateSnapshot,
  riskCategory: ToolRiskCategory,
  toolId?: string
): PermissionDecision {
  return resolvePermissionDecision({
    ...snapshot,
    riskCategory,
    sessionGrants: new Set(snapshot.sessionGrants),
    ...(toolId ? { toolId } : {}),
  });
}

/**
 * Freeze the admitted DENIES (and, elsewhere, the admitted tool catalog) while
 * letting every other decision follow the current root policy — grants and
 * reductions alike. Returns an explicit per-tool snapshot so callers never need
 * to re-derive session grants or yolo from either input.
 */
export function intersectChildPermissionCeilings(
  admitted: PermissionToolGateSnapshot | undefined,
  current: PermissionToolGateSnapshot | undefined
): PermissionToolGateSnapshot | undefined {
  if (!admitted) {
    return current;
  }
  if (!current) {
    return admitted;
  }
  const policies = { ...admitted.policies };
  for (const risk of risks) {
    policies[risk] = combine(decision(admitted, risk), decision(current, risk));
  }
  const ids = new Set([
    ...Object.keys(admitted.riskByTool ?? {}),
    ...Object.keys(current.riskByTool ?? {}),
    ...Object.keys(admitted.perToolOverrides ?? {}),
    ...Object.keys(current.perToolOverrides ?? {}),
  ]);
  const perToolOverrides: Record<string, PermissionDecision> = {};
  for (const id of ids) {
    perToolOverrides[id] = combine(
      decision(admitted, admitted.riskByTool?.[id] ?? admitted.defaultRisk ?? 'mcp', id),
      decision(current, current.riskByTool?.[id] ?? current.defaultRisk ?? 'mcp', id)
    );
  }
  // Tools missing from both classifications obey the admitted default's deny and
  // otherwise the current default. Known classifications have exact per-tool
  // decisions above, so this cannot widen past an admitted deny.
  policies.mcp = combine(
    decision(admitted, admitted.defaultRisk ?? 'mcp'),
    decision(current, current.defaultRisk ?? 'mcp')
  );
  return {
    defaultRisk: 'mcp',
    perToolOverrides,
    policies,
    riskByTool: { ...admitted.riskByTool, ...current.riskByTool },
    yolo: false,
  };
}
