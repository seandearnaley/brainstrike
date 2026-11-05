import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { intersectChildPermissionCeilings } from '../child-permission-ceiling.ts';
import {
  DEFAULT_PERMISSION_POLICIES,
  isPermissionDenied,
  type PermissionDecision,
  type PermissionToolGateSnapshot,
  resolvePermissionDecision,
} from '../permission-policy.ts';
import type { ToolRiskCategory } from '../tool-risk.ts';

const RISKS: readonly ToolRiskCategory[] = ['read', 'edit', 'execute', 'mcp'];
const DECISIONS: readonly PermissionDecision[] = ['allow', 'ask', 'deny'];
/** Two classified tools and one neither snapshot classifies (it takes the default risk). */
const TOOLS = ['write_file', 'run_shell', 'external_tool'] as const;
type ToolId = (typeof TOOLS)[number];
const DEFAULT_RISK: ToolRiskCategory = 'mcp';

/**
 * The decision the host enforces for one tool call (ADR-0010): an explicit
 * deny, the tool's own or its category's, wins over YOLO and grants; the
 * resolver decides the rest. Mirrors agent-host's `hostPolicyDecision`.
 */
function gate(
  snapshot: PermissionToolGateSnapshot,
  risk: ToolRiskCategory,
  toolId: string
): PermissionDecision {
  if (isPermissionDenied(snapshot, risk, toolId)) {
    return 'deny';
  }
  return resolvePermissionDecision({
    ...snapshot,
    riskCategory: risk,
    sessionGrants: new Set(snapshot.sessionGrants),
    toolId,
  });
}

const decision = fc.constantFrom(...DECISIONS);
const risk = fc.constantFrom(...RISKS);

/** One classification shared by the admitted and live snapshots: risk is a fact, not authority. */
const classification = fc.record({ run_shell: risk, write_file: risk });

function snapshot(
  riskByTool: Record<string, ToolRiskCategory>
): fc.Arbitrary<PermissionToolGateSnapshot> {
  return fc.record({
    defaultRisk: fc.constant(DEFAULT_RISK),
    perToolOverrides: fc.dictionary(fc.constantFrom(...TOOLS), decision, { maxKeys: TOOLS.length }),
    policies: fc.record({ edit: decision, execute: decision, mcp: decision, read: decision }),
    riskByTool: fc.constant(riskByTool),
    sessionGrants: fc.subarray([...RISKS]),
    yolo: fc.boolean(),
  });
}

/** An admitted snapshot, the root's live snapshot, and one tool the child calls. */
const scenario = classification.chain((riskByTool) =>
  fc.record({
    admitted: snapshot(riskByTool),
    live: snapshot(riskByTool),
    toolId: fc.constantFrom(...TOOLS),
  })
);

function riskOf(snapshot: PermissionToolGateSnapshot, toolId: ToolId): ToolRiskCategory {
  return snapshot.riskByTool?.[toolId] ?? DEFAULT_RISK;
}

function childCeiling(
  admitted: PermissionToolGateSnapshot,
  live: PermissionToolGateSnapshot
): PermissionToolGateSnapshot {
  const ceiling = intersectChildPermissionCeilings(admitted, live);
  if (!ceiling) {
    throw new Error('Two snapshots always produce a ceiling');
  }
  return ceiling;
}

describe('intersectChildPermissionCeilings', () => {
  it('keeps a deny the root adds in Full access after the child was admitted', () => {
    const admitted: PermissionToolGateSnapshot = {
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'allow' },
      riskByTool: { write_file: 'edit' },
      yolo: false,
    };
    const live: PermissionToolGateSnapshot = {
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'deny' },
      riskByTool: { write_file: 'edit' },
      yolo: true,
    };

    expect(gate(live, 'edit', 'write_file')).toBe('deny');
    expect(gate(childCeiling(admitted, live), 'edit', 'write_file')).toBe('deny');
  });

  it('never lets a child run what its admitted snapshot or its live root denies', () => {
    fc.assert(
      fc.property(scenario, ({ admitted, live, toolId }) => {
        const risk = riskOf(live, toolId);
        if (gate(admitted, risk, toolId) !== 'deny' && gate(live, risk, toolId) !== 'deny') {
          return;
        }
        expect(gate(childCeiling(admitted, live), risk, toolId)).toBe('deny');
      })
    );
  });

  it('follows the live root wherever neither snapshot denies', () => {
    fc.assert(
      fc.property(scenario, ({ admitted, live, toolId }) => {
        const risk = riskOf(live, toolId);
        if (gate(admitted, risk, toolId) === 'deny' || gate(live, risk, toolId) === 'deny') {
          return;
        }
        expect(gate(childCeiling(admitted, live), risk, toolId)).toBe(gate(live, risk, toolId));
      })
    );
  });
});
