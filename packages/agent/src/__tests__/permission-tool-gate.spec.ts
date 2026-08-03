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
 * - a SELF-APPROVING suspending tool (BST-1097) gated to `'ask'` is kept
 *   UNCLONED — no `requireApproval` flag, ever — while still recorded as ask;
 *   if its registered form lost the suspendSchema it is fail-safe omitted.
 */
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  filterToolsByPermissionWithMetadata,
  type PermissionToolGateLogger,
  resolveSelfApprovalDecision,
} from '../mastra/permission-tool-gate';

function noopLogger(): PermissionToolGateLogger {
  return { info: () => {}, warn: () => {} };
}

// A minimal tool map shape — the gate never inspects tool internals, it only
// keys by the sanitized id and copies the value across.
const TOOLS = {
  edit_tool: { id: 'edit_tool' },
  execute_tool: { id: 'execute_tool' },
  read_tool: { id: 'read_tool' },
} as const;

const RISK_BY_TOOL = {
  edit_tool: 'edit',
  execute_tool: 'execute',
  read_tool: 'read',
} as const;

function snapshot(overrides: Partial<PermissionToolGateSnapshot> = {}): PermissionToolGateSnapshot {
  return {
    defaultRisk: 'mcp',
    policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
    riskByTool: { ...RISK_BY_TOOL },
    yolo: false,
    ...overrides,
  };
}

// Identity map: the sanitized id IS the original name for these test tools.
const NAME_MAP: ReadonlyMap<string, string> = new Map(Object.keys(TOOLS).map((id) => [id, id]));

describe('filterToolsByPermissionWithMetadata', () => {
  it('keeps session inspection free and approval-gates session management', () => {
    const tools = {
      brainstrike_inspectCommandSessions: { id: 'brainstrike.inspectCommandSessions' },
      brainstrike_manageCommandSession: { id: 'brainstrike.manageCommandSession' },
    };
    const names = new Map([
      ['brainstrike_inspectCommandSessions', 'brainstrike.inspectCommandSessions'],
      ['brainstrike_manageCommandSession', 'brainstrike.manageCommandSession'],
    ]);
    const result = filterToolsByPermissionWithMetadata(
      tools,
      snapshot({
        riskByTool: {
          'brainstrike.inspectCommandSessions': 'read',
          'brainstrike.manageCommandSession': 'execute',
        },
      }),
      names,
      noopLogger()
    );

    expect(result.tools).toHaveProperty('brainstrike_inspectCommandSessions');
    expect(result.askToolIds.has('brainstrike_inspectCommandSessions')).toBe(false);
    expect(result.askToolIds.has('brainstrike_manageCommandSession')).toBe(true);
    expect(
      (result.tools.brainstrike_manageCommandSession as { requireApproval?: unknown })
        .requireApproval
    ).toBe(true);
  });

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
      snapshot({ policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' } }),
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

describe('self-approving suspending tools (BST-1097)', () => {
  const RUN_PYTHON_NAME_MAP: ReadonlyMap<string, string> = new Map([
    ['brainstrike_runPython', 'brainstrike.runPython'],
  ]);

  function runPythonSnapshot(): PermissionToolGateSnapshot {
    return snapshot({ riskByTool: { 'brainstrike.runPython': 'execute' } });
  }

  it("keeps run_python UNCLONED on 'ask' — no requireApproval flag, ever — while still recording ask metadata", () => {
    // The flag is the BST-1097 defect: Mastra re-checks it on the Gate B
    // resume leg and denies a resume whose data has no `approved` key. The
    // tool raises Gate A itself, so the gate must keep the ORIGINAL object.
    const tool = { id: 'brainstrike.runPython', suspendSchema: { kind: 'union' } };
    const result = filterToolsByPermissionWithMetadata(
      { brainstrike_runPython: tool },
      runPythonSnapshot(),
      RUN_PYTHON_NAME_MAP,
      noopLogger()
    );

    expect(result.tools['brainstrike_runPython']).toBe(tool);
    expect(
      (result.tools['brainstrike_runPython'] as { requireApproval?: unknown }).requireApproval
    ).toBeUndefined();
    // Still an ask tool: the approval chunk's risk metadata and the
    // no-storage fail-safe both key on this record.
    expect(result.askToolIds.has('brainstrike_runPython')).toBe(true);
    expect(result.askTools.get('brainstrike_runPython')).toEqual({
      originalName: 'brainstrike.runPython',
      riskCategory: 'execute',
    });
  });

  it('fail-safe OMITS a self-approving ask tool whose registered form lost its suspendSchema', () => {
    // Without a suspendSchema the tool cannot raise Gate A; keeping it would
    // run it unprompted, and re-arming the flag would re-create the Gate B
    // dead end. Omission is the only safe shape, and it must be loud.
    const warn = vi.fn();
    const result = filterToolsByPermissionWithMetadata(
      { brainstrike_runPython: { id: 'brainstrike.runPython' } },
      runPythonSnapshot(),
      RUN_PYTHON_NAME_MAP,
      { info: () => {}, warn }
    );

    expect(result.tools).not.toHaveProperty('brainstrike_runPython');
    expect(result.askToolIds.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no suspendSchema'),
      expect.objectContaining({
        code: 'permission_tool_gate_self_approving_missing_suspend_schema',
      })
    );
  });

  it("still resolves 'allow'/'deny' for run_python exactly like any other tool", () => {
    const tool = { id: 'brainstrike.runPython', suspendSchema: {} };
    const allowed = filterToolsByPermissionWithMetadata(
      { brainstrike_runPython: tool },
      snapshot({
        riskByTool: { 'brainstrike.runPython': 'execute' },
        sessionGrants: ['execute'],
      }),
      RUN_PYTHON_NAME_MAP,
      noopLogger()
    );
    expect(allowed.tools['brainstrike_runPython']).toBe(tool);
    expect(allowed.askToolIds.size).toBe(0);

    const denied = filterToolsByPermissionWithMetadata(
      { brainstrike_runPython: tool },
      snapshot({
        perToolOverrides: { 'brainstrike.runPython': 'deny' },
        riskByTool: { 'brainstrike.runPython': 'execute' },
      }),
      RUN_PYTHON_NAME_MAP,
      noopLogger()
    );
    expect(denied.tools).not.toHaveProperty('brainstrike_runPython');
  });
});

describe('resolveSelfApprovalDecision', () => {
  const TOOL_ID = 'brainstrike.runPython';

  function executeAskSnapshot(
    overrides: Partial<PermissionToolGateSnapshot> = {}
  ): PermissionToolGateSnapshot {
    return snapshot({ riskByTool: { [TOOL_ID]: 'execute' }, ...overrides });
  }

  it("returns 'allow' when no snapshot is enforced (the passthrough posture)", () => {
    expect(resolveSelfApprovalDecision(undefined, TOOL_ID)).toBe('allow');
  });

  it("mirrors the gate: execute:'ask' → 'ask'", () => {
    expect(resolveSelfApprovalDecision(executeAskSnapshot(), TOOL_ID)).toBe('ask');
  });

  it("mirrors every grant surface: per-tool override, session grant, and yolo all resolve 'allow'", () => {
    expect(
      resolveSelfApprovalDecision(
        executeAskSnapshot({ perToolOverrides: { [TOOL_ID]: 'allow' } }),
        TOOL_ID
      )
    ).toBe('allow');
    expect(
      resolveSelfApprovalDecision(executeAskSnapshot({ sessionGrants: ['execute'] }), TOOL_ID)
    ).toBe('allow');
    expect(resolveSelfApprovalDecision(executeAskSnapshot({ yolo: true }), TOOL_ID)).toBe('allow');
  });

  it("maps 'deny' to 'ask' — the fail-safe direction for a direct invocation (in-agent, the gate already omitted the tool)", () => {
    expect(
      resolveSelfApprovalDecision(
        executeAskSnapshot({ perToolOverrides: { [TOOL_ID]: 'deny' } }),
        TOOL_ID
      )
    ).toBe('ask');
  });
});
