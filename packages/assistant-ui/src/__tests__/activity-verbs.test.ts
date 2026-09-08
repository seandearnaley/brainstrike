import { NATIVE_TOOL_ID, NATIVE_TOOL_IDS } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { TOOL_VERBS, verbForTool } from '../activity-verbs';

describe('TOOL_VERBS', () => {
  it('covers every native tool id in the catalog with a non-empty active/done pair', () => {
    for (const id of NATIVE_TOOL_IDS) {
      const verb = TOOL_VERBS[id];
      expect(verb, id).toBeDefined();
      expect(verb.active.length, id).toBeGreaterThan(0);
      expect(verb.done.length, id).toBeGreaterThan(0);
      expect(verb.active, id).not.toBe(verb.done);
    }
  });

  it('spells the core verbs the design fixed', () => {
    expect(TOOL_VERBS[NATIVE_TOOL_ID.readWorkspaceFile]).toEqual({
      active: 'Reading',
      done: 'Read',
      family: 'read',
    });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.grepSearch]).toEqual({
      active: 'Searching',
      done: 'Searched',
      family: 'search',
    });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.writeWorkspaceFile]).toEqual({
      active: 'Editing',
      done: 'Edited',
      family: 'edit',
    });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.executeCommand]).toEqual({
      active: 'Running',
      done: 'Ran',
      family: 'run',
    });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.webSearch]).toEqual({
      active: 'Searching the web',
      done: 'Searched the web',
      family: 'web',
    });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.manageCanvas]).toEqual({
      active: 'Updating canvas',
      done: 'Updated canvas',
      family: 'canvas',
    });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.askUser]).toEqual({
      active: 'Asking',
      done: 'Asked',
      family: 'ask',
    });
  });
});

describe('verbForTool', () => {
  it('resolves native ids in dotted and sanitized form', () => {
    expect(verbForTool('brainstrike.readWorkspaceFile').done).toBe('Read');
    expect(verbForTool('brainstrike_readWorkspaceFile').done).toBe('Read');
  });

  it('describes a delegation by persona label', () => {
    expect(verbForTool('agent-explore')).toEqual({
      active: 'Delegating to Explorer',
      done: 'Delegated to Explorer',
      family: 'delegate',
    });
  });

  it('describes an MCP tool by its server.tool name', () => {
    expect(verbForTool('linear.get_issue')).toEqual({
      active: 'Calling linear.get_issue',
      done: 'Called linear.get_issue',
      family: 'call',
    });
  });

  it('never guesses for an unknown name', () => {
    expect(verbForTool('mystery')).toEqual({
      active: 'Using mystery',
      done: 'Used mystery',
      family: 'other',
    });
  });
});
