/**
 * Unit coverage for the permission tool gate's ask→keep + metadata contract.
 *
 * The gate is pure: given a guarded tool map, a permission snapshot, and a
 * toolName map, it returns the filtered map plus the set of `'ask'`-gated tool
 * ids. These tests pin the security-critical decisions:
 * - `'ask'`  → tool KEPT and recorded in `askToolIds` (so the runtime can force
 *   per-call approval; never silently run).
 * - `'deny'` → tool OMITTED, NOT in `askToolIds`.
 * - `'allow'`→ tool KEPT, NOT in `askToolIds`.
 * - a session grant / YOLO downgrades `'ask'`→`'allow'`, so the tool is kept but
 *   NOT recorded as ask (it runs free, no approval).
 */
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { describe, expect, it } from 'vitest';
import {
  filterToolsByPermissionWithMetadata,
  type PermissionToolGateLogger,
} from '../mastra/permission-tool-gate';

function noopLogger(): PermissionToolGateLogger {
  return { info: () => {}, warn: () => {} };
}

// A minimal tool map shape — the gate never inspects tool internals, it only
// keys by the sanitized id and copies the value across.
const TOOLS = {
  read_tool: { id: 'read_tool' },
  edit_tool: { id: 'edit_tool' },
  execute_tool: { id: 'execute_tool' },
} as const;

const RISK_BY_TOOL = {
  read_tool: 'read',
  edit_tool: 'edit',
  execute_tool: 'execute',
} as const;

function snapshot(overrides: Partial<PermissionToolGateSnapshot> = {}): PermissionToolGateSnapshot {
  return {
    policies: { read: 'allow', edit: 'ask', execute: 'ask', mcp: 'allow' },
    yolo: false,
    riskByTool: { ...RISK_BY_TOOL },
    defaultRisk: 'mcp',
    ...overrides,
  };
}

// Identity map: the sanitized id IS the original name for these test tools.
const NAME_MAP: ReadonlyMap<string, string> = new Map(Object.keys(TOOLS).map((id) => [id, id]));

describe('filterToolsByPermissionWithMetadata', () => {
  it("keeps an 'ask' tool in the map AND records it in askToolIds", () => {
    const result = filterToolsByPermissionWithMetadata(
      { ...TOOLS },
      snapshot(),
      NAME_MAP,
      noopLogger()
    );

    // edit + execute are 'ask' → kept and recorded; read is 'allow' → kept, not recorded.
    expect(Object.keys(result.tools).sort()).toEqual(['edit_tool', 'execute_tool', 'read_tool']);
    expect([...result.askToolIds].sort()).toEqual(['edit_tool', 'execute_tool']);
    expect(result.askTools.get('edit_tool')).toEqual({
      originalName: 'edit_tool',
      riskCategory: 'edit',
    });
    expect(result.askTools.get('execute_tool')).toEqual({
      originalName: 'execute_tool',
      riskCategory: 'execute',
    });
    // 'allow' tool is NOT in askToolIds.
    expect(result.askToolIds.has('read_tool')).toBe(false);
    // Each kept 'ask' tool is a CLONE carrying the PER-TOOL requireApproval flag
    // (so only it suspends, not allowed tools in the same run); 'allow' is not.
    expect((result.tools.edit_tool as { requireApproval?: unknown }).requireApproval).toBe(true);
    expect((result.tools.execute_tool as { requireApproval?: unknown }).requireApproval).toBe(true);
    expect(
      (result.tools.read_tool as { requireApproval?: unknown }).requireApproval
    ).toBeUndefined();
  });

  it('does NOT mutate the original ask tool when cloning (sets requireApproval on a copy)', () => {
    const input = { ...TOOLS };
    const result = filterToolsByPermissionWithMetadata(input, snapshot(), NAME_MAP, noopLogger());
    // The clone carries the flag; the original input object is untouched.
    expect((result.tools.edit_tool as { requireApproval?: unknown }).requireApproval).toBe(true);
    expect((input.edit_tool as { requireApproval?: unknown }).requireApproval).toBeUndefined();
    expect(result.tools.edit_tool).not.toBe(input.edit_tool);
  });

  it("omits a 'deny' tool and does NOT record it in askToolIds", () => {
    const result = filterToolsByPermissionWithMetadata(
      { ...TOOLS },
      snapshot({ policies: { read: 'allow', edit: 'deny', execute: 'ask', mcp: 'allow' } }),
      NAME_MAP,
      noopLogger()
    );

    expect(result.tools).not.toHaveProperty('edit_tool');
    expect(result.askToolIds.has('edit_tool')).toBe(false);
    // execute is still 'ask' → kept + recorded.
    expect(result.tools).toHaveProperty('execute_tool');
    expect([...result.askToolIds]).toEqual(['execute_tool']);
  });

  it('downgrades ask→allow via a sessionGrant (kept, NOT recorded as ask)', () => {
    const result = filterToolsByPermissionWithMetadata(
      { ...TOOLS },
      snapshot({ sessionGrants: ['edit', 'execute'] }),
      NAME_MAP,
      noopLogger()
    );

    // Both edit + execute are session-granted → allow → kept, but NOT ask.
    expect(result.tools).toHaveProperty('edit_tool');
    expect(result.tools).toHaveProperty('execute_tool');
    expect(result.askToolIds.size).toBe(0);
  });

  it('downgrades ask→allow under YOLO (kept, NOT recorded as ask)', () => {
    const result = filterToolsByPermissionWithMetadata(
      { ...TOOLS },
      snapshot({ yolo: true }),
      NAME_MAP,
      noopLogger()
    );

    expect(Object.keys(result.tools).sort()).toEqual(['edit_tool', 'execute_tool', 'read_tool']);
    expect(result.askToolIds.size).toBe(0);
  });

  it('downgrades ask→allow via a per-tool override (kept, NOT recorded as ask)', () => {
    const result = filterToolsByPermissionWithMetadata(
      { ...TOOLS },
      snapshot({ perToolOverrides: { edit_tool: 'allow' } }),
      NAME_MAP,
      noopLogger()
    );

    expect(result.tools).toHaveProperty('edit_tool');
    expect(result.askToolIds.has('edit_tool')).toBe(false);
    // execute is still 'ask'.
    expect([...result.askToolIds]).toEqual(['execute_tool']);
  });

  it('returns the map unchanged with empty askToolIds when no snapshot is provided', () => {
    const input = { ...TOOLS };
    const result = filterToolsByPermissionWithMetadata(input, undefined, NAME_MAP, noopLogger());

    expect(result.tools).toBe(input);
    expect(result.askToolIds.size).toBe(0);
    expect(result.askTools.size).toBe(0);
  });

  it('does not mutate the input tool map (purity)', () => {
    const input = { ...TOOLS };
    filterToolsByPermissionWithMetadata(input, snapshot(), NAME_MAP, noopLogger());
    expect(Object.keys(input).sort()).toEqual(['edit_tool', 'execute_tool', 'read_tool']);
  });
});
