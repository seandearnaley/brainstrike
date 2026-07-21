import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  filterToolsForPlanMode,
  hasSuspendSchema,
  resolveSuspendToolsForRun,
} from '../plan-mode-tool-gate';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

// The gate keys tools by SANITIZED id; brainstrike.* ids sanitize to underscores.
const toolNameMap = new Map<string, string>([
  ['brainstrike_readWorkspaceFile', 'brainstrike.readWorkspaceFile'],
  ['brainstrike_inspectCommandSessions', 'brainstrike.inspectCommandSessions'],
  ['brainstrike_manageCommandSession', 'brainstrike.manageCommandSession'],
  ['brainstrike_writeWorkspaceFile', 'brainstrike.writeWorkspaceFile'],
  ['brainstrike_submitPlan', 'brainstrike.submitPlan'],
  ['brainstrike_askUser', 'brainstrike.askUser'],
  ['some_mcp_tool', 'some.mcp.tool'],
]);

const riskByTool: Record<string, ToolRiskCategory> = {
  'brainstrike.askUser': 'read',
  'brainstrike.inspectCommandSessions': 'read',
  'brainstrike.manageCommandSession': 'execute',
  'brainstrike.readWorkspaceFile': 'read',
  'brainstrike.submitPlan': 'read',
  'brainstrike.writeWorkspaceFile': 'edit',
};

function makeToolMap() {
  return {
    brainstrike_askUser: { id: 'brainstrike.askUser', suspendSchema: {} },
    brainstrike_inspectCommandSessions: { id: 'brainstrike.inspectCommandSessions' },
    brainstrike_manageCommandSession: { id: 'brainstrike.manageCommandSession' },
    brainstrike_readWorkspaceFile: { id: 'brainstrike.readWorkspaceFile' },
    brainstrike_submitPlan: { id: 'brainstrike.submitPlan', suspendSchema: {} },
    brainstrike_writeWorkspaceFile: { id: 'brainstrike.writeWorkspaceFile' },
    some_mcp_tool: { id: 'some.mcp.tool' },
  };
}

describe('hasSuspendSchema', () => {
  it('detects a tool declaring suspendSchema', () => {
    expect(hasSuspendSchema({ suspendSchema: {} })).toBe(true);
    expect(hasSuspendSchema({ id: 'x' })).toBe(false);
    expect(hasSuspendSchema(null)).toBe(false);
  });
});

describe('filterToolsForPlanMode', () => {
  it('keeps read + mcp + suspending tools and drops edit/execute tools', () => {
    const result = filterToolsForPlanMode(makeToolMap(), toolNameMap, riskByTool, makeLogger());
    expect(Object.keys(result).sort()).toEqual([
      'brainstrike_askUser',
      'brainstrike_inspectCommandSessions',
      'brainstrike_readWorkspaceFile',
      'brainstrike_submitPlan',
      'some_mcp_tool',
    ]);
    expect(result).not.toHaveProperty('brainstrike_writeWorkspaceFile');
    expect(result).not.toHaveProperty('brainstrike_manageCommandSession');
  });

  it('keeps a suspending tool even when its risk map entry is missing', () => {
    const tools = { brainstrike_submitPlan: { id: 'brainstrike.submitPlan', suspendSchema: {} } };
    const result = filterToolsForPlanMode(tools, new Map(), {}, makeLogger());
    expect(result).toHaveProperty('brainstrike_submitPlan');
  });
});

describe('resolveSuspendToolsForRun', () => {
  it('returns the map unchanged when storage is present', () => {
    const tools = makeToolMap();
    expect(resolveSuspendToolsForRun(tools, true, toolNameMap, makeLogger())).toBe(tools);
  });

  it('omits suspending tools when storage is absent (fail-safe)', () => {
    const logger = makeLogger();
    const result = resolveSuspendToolsForRun(makeToolMap(), false, toolNameMap, logger);
    expect(result).not.toHaveProperty('brainstrike_submitPlan');
    expect(result).not.toHaveProperty('brainstrike_askUser');
    // Non-suspending tools survive.
    expect(result).toHaveProperty('brainstrike_readWorkspaceFile');
    expect(result).toHaveProperty('brainstrike_writeWorkspaceFile');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
