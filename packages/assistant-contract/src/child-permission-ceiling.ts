import {
  type PermissionDecision,
  type PermissionToolGateSnapshot,
  resolvePermissionDecision,
} from './permission-policy.js';
import type { ToolRiskCategory } from './tool-risk.js';

const rank = { allow: 0, ask: 1, deny: 2 } as const;
const risks = ['read', 'edit', 'execute', 'mcp'] as const;
const stricter = (a: PermissionDecision, b: PermissionDecision): PermissionDecision =>
  rank[a] >= rank[b] ? a : b;

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

/** Freeze admitted authority while honoring any subsequent reduction by the root. */
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
    policies[risk] = stricter(decision(admitted, risk), decision(current, risk));
  }
  const ids = new Set([
    ...Object.keys(admitted.riskByTool ?? {}),
    ...Object.keys(current.riskByTool ?? {}),
    ...Object.keys(admitted.perToolOverrides ?? {}),
    ...Object.keys(current.perToolOverrides ?? {}),
  ]);
  const perToolOverrides: Record<string, PermissionDecision> = {};
  for (const id of ids) {
    perToolOverrides[id] = stricter(
      decision(admitted, admitted.riskByTool?.[id] ?? admitted.defaultRisk ?? 'mcp', id),
      decision(current, current.riskByTool?.[id] ?? current.defaultRisk ?? 'mcp', id)
    );
  }
  // Tools missing from both classifications still obey BOTH defaults. Known
  // classifications have exact per-tool decisions above, so this cannot widen them.
  policies.mcp = stricter(
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
