import {
  buildNativeToolRiskMap,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';
import {
  hasRegisteredSuspendResumeUi,
  REGISTERED_SUSPEND_RESUME_TOOL_IDS,
} from '@brainstrike/assistant-contract/tool-suspend';
import { describe, expect, it, vi } from 'vitest';
import { createAskUserTool } from '../../tools/ask-user-tool';
import { createRunPythonTool } from '../../tools/run-python-tool';
import { createSubmitPlanTool } from '../../tools/submit-plan-tool';
import {
  ASK_USER_TOOL_ID,
  filterToolsForPlanMode,
  hasSuspendSchema,
  resolveSuspendToolsForRun,
  SUBMIT_PLAN_TOOL_ID,
  SUSPENDING_NATIVE_TOOL_IDS,
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

// A tool that CAN suspend() but has no registered typed resume UI pauses runs
// this build cannot answer. That direction has no compile-time guard, so it is
// guarded here.
describe('suspending tools vs the resume-UI registry', () => {
  it('derives SUSPENDING_NATIVE_TOOL_IDS from REGISTERED_SUSPEND_RESUME_TOOL_IDS', () => {
    expect([...SUSPENDING_NATIVE_TOOL_IDS]).toEqual([...REGISTERED_SUSPEND_RESUME_TOOL_IDS]);
    for (const toolId of SUSPENDING_NATIVE_TOOL_IDS) {
      expect(hasRegisteredSuspendResumeUi(toolId)).toBe(true);
    }
  });

  it('every REAL suspending tool factory has a registered resume UI', () => {
    const runPythonTool = createRunPythonTool({
      resolveApprovalDecision: () => 'allow',
      resolveHost: () => Promise.reject(new Error('unused in this test')),
    });
    for (const tool of [createAskUserTool(), runPythonTool, createSubmitPlanTool()]) {
      expect(hasSuspendSchema(tool)).toBe(true);
      expect(hasRegisteredSuspendResumeUi(tool.id)).toBe(true);
    }
  });

  // The reverse-drift scan ("no OTHER module declares a suspendSchema") lives in
  // scripts/__tests__/suspending-tool-registry-contract.test.mjs: it must walk
  // BOTH tool source roots recursively (suspending tools are defined in
  // packages/agent but registered in apps/desktop), which a package-scoped
  // vitest cannot do without turning a foreign package's source into an
  // unhashed turbo input. It is control-tested there against subdirectory,
  // shorthand, desktop-root, and comment-only fixtures.
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

  // A suspend schema is NOT a plan-mode admission ticket. Both tools that carry
  // one today (submitPlan/askUser) are riskCategory 'read', so this was latent
  // — but run_python needs a suspend schema for its per-call network
  // escalation, and admitting an execute-risk arbitrary-code tool into plan
  // mode would defeat the entire point of plan mode.
  it('omits an execute-risk suspending tool', () => {
    const logger = makeLogger();
    const tools = {
      brainstrike_runPython: { id: 'brainstrike.runPython', suspendSchema: {} },
    };
    const result = filterToolsForPlanMode(
      tools,
      new Map([['brainstrike_runPython', 'brainstrike.runPython']]),
      { 'brainstrike.runPython': 'execute' },
      logger
    );
    expect(result).not.toHaveProperty('brainstrike_runPython');
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'plan_mode_tool_omitted', riskCategory: 'execute' })
    );
  });

  // The OTHER side of the coupling this change introduces: submitPlan/askUser
  // now stay in plan mode ONLY because the real catalog classifies them 'read'.
  // Reclassify either (say someone decides submitPlan should be approval-gated
  // and flips it to 'edit') and plan mode silently loses its only exit path —
  // the model could investigate forever but never submit a plan. Uses the REAL
  // buildNativeToolRiskMap rather than the hand-written fixture, so the
  // classification itself is what is pinned.
  it('keeps submitPlan/askUser under the REAL risk catalog (kept as read, not as suspenders)', () => {
    const tools = {
      brainstrike_askUser: { id: ASK_USER_TOOL_ID, suspendSchema: {} },
      brainstrike_submitPlan: { id: SUBMIT_PLAN_TOOL_ID, suspendSchema: {} },
    };
    const result = filterToolsForPlanMode(
      tools,
      new Map([
        ['brainstrike_askUser', ASK_USER_TOOL_ID],
        ['brainstrike_submitPlan', SUBMIT_PLAN_TOOL_ID],
      ]),
      buildNativeToolRiskMap(),
      makeLogger()
    );
    expect(result).toHaveProperty('brainstrike_askUser');
    expect(result).toHaveProperty('brainstrike_submitPlan');
  });

  it('omits an edit-risk suspending tool', () => {
    const tools = {
      brainstrike_editThing: { id: 'brainstrike.editThing', suspendSchema: {} },
    };
    const result = filterToolsForPlanMode(
      tools,
      new Map([['brainstrike_editThing', 'brainstrike.editThing']]),
      { 'brainstrike.editThing': 'edit' },
      makeLogger()
    );
    expect(result).not.toHaveProperty('brainstrike_editThing');
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
