// @vitest-environment node
import { HOST_META_TOOL_ID, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { verbForTool } from '../activity-verbs';

describe('native tool verbs', () => {
  // `countsFiles` folds a distinct-target file count into the resting summary
  // (`restingLabel`, activity-trace-model.ts). It is deliberately NOT the
  // `read` family: a directory listing is a read whose target is not a file,
  // and folding the family read "Listed 2 files".
  it('counts files for file reads and edits, never for a directory listing', () => {
    expect(verbForTool(NATIVE_TOOL_ID.readWorkspaceFile).countsFiles).toBe('plural');
    expect(verbForTool(NATIVE_TOOL_ID.writeWorkspaceFile).countsFiles).toBe('always');
    expect(verbForTool(NATIVE_TOOL_ID.readWorkspaceDirectory)).toMatchObject({ family: 'read' });
    expect(verbForTool(NATIVE_TOOL_ID.readWorkspaceDirectory).countsFiles).toBeUndefined();
  });

  it('spells the core verbs the design fixed', () => {
    expect(verbForTool(NATIVE_TOOL_ID.readWorkspaceFile)).toEqual({
      active: 'Reading',
      countsFiles: 'plural',
      done: 'Read',
      family: 'read',
      request: 'Read',
    });
    expect(verbForTool(NATIVE_TOOL_ID.grepSearch)).toEqual({
      active: 'Searching',
      done: 'Searched',
      family: 'search',
      request: 'Search',
    });
    expect(verbForTool(NATIVE_TOOL_ID.writeWorkspaceFile)).toEqual({
      active: 'Editing',
      countsFiles: 'always',
      done: 'Edited',
      family: 'edit',
      request: 'Edit',
    });
    expect(verbForTool(NATIVE_TOOL_ID.executeCommand)).toEqual({
      active: 'Running',
      done: 'Ran',
      family: 'run',
      request: 'Run',
    });
    expect(verbForTool(NATIVE_TOOL_ID.webSearch)).toEqual({
      active: 'Searching the web',
      done: 'Searched the web',
      family: 'web',
      request: 'Search the web',
    });
    expect(verbForTool(NATIVE_TOOL_ID.runSkillScript)).toEqual({
      active: 'Running skill script',
      done: 'Ran skill script',
      family: 'skill',
      request: 'Run skill script',
    });
    expect(verbForTool(NATIVE_TOOL_ID.askUser)).toEqual({
      active: 'Asking',
      done: 'Asked',
      family: 'ask',
      request: 'Ask',
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
      request: 'Delegate to Explorer',
    });
  });

  it('describes an MCP tool by its server.tool name', () => {
    expect(verbForTool('linear.get_issue')).toEqual({
      active: 'Calling linear.get_issue',
      done: 'Called linear.get_issue',
      family: 'call',
      namesTool: true,
      request: 'Call linear.get_issue',
    });
  });

  it('never guesses for an unknown name', () => {
    expect(verbForTool('mystery')).toEqual({
      active: 'Using mystery',
      done: 'Used mystery',
      family: 'other',
      namesTool: true,
      request: 'Use mystery',
    });
  });

  // Live QA 2026-10-16: the host's discovery and working-memory tools are in
  // nearly every thread and read "Used search_tools" / "Used updateWorkingMemory".
  it.each([
    [
      HOST_META_TOOL_ID.updateWorkingMemory,
      {
        active: 'Updating memory',
        done: 'Updated memory',
        family: 'memory',
        request: 'Update memory',
        targetArg: null,
      },
    ],
    [
      HOST_META_TOOL_ID.searchTools,
      {
        active: 'Searching tools',
        done: 'Searched tools',
        family: 'tools',
        request: 'Search tools',
        targetArg: 'query',
      },
    ],
    [
      HOST_META_TOOL_ID.loadTool,
      {
        active: 'Loading tool',
        done: 'Loaded tool',
        family: 'tools',
        request: 'Load tool',
        targetArg: ['toolName', 'toolNames'],
      },
    ],
    [
      HOST_META_TOOL_ID.listAvailableTools,
      {
        active: 'Listing tools',
        done: 'Listed tools',
        family: 'tools',
        request: 'List tools',
        targetArg: null,
      },
    ],
  ])('names the host meta tool %s by what it does', (id, expected) => {
    expect(verbForTool(id)).toEqual(expected);
  });

  // Live QA 2026-10-16: "Updated canvas" for a call that created one.
  it.each([
    [
      { action: 'create', html: '<p/>', title: 'Plan' },
      'Creating canvas',
      'Created canvas',
      'title',
    ],
    [{ action: 'list' }, 'Listing canvases', 'Listed canvases', null],
    [
      { action: 'update', canvasId: 'c1', newString: 'b', oldString: 'a' },
      'Updating canvas',
      'Updated canvas',
      null,
    ],
    [
      { action: 'rewrite', canvasId: 'c1', html: '<p/>' },
      'Updating canvas',
      'Updated canvas',
      null,
    ],
  ] as const)('reads a canvas call by its action (%o)', (args, active, done, targetArg) => {
    const verb = verbForTool(NATIVE_TOOL_ID.manageCanvas, args);
    expect(verb).toMatchObject({ active, done, family: 'canvas', targetArg });
    expect(verbForTool('brainstrike_manageCanvas', args).done).toBe(done);
  });

  it('names a canvas call whose action has not streamed yet without claiming one', () => {
    expect(verbForTool(NATIVE_TOOL_ID.manageCanvas, {})).toMatchObject({
      active: 'Managing canvas',
      done: 'Managed canvas',
      targetArg: null,
    });
    expect(verbForTool(NATIVE_TOOL_ID.manageCanvas)).toEqual(
      verbForTool(NATIVE_TOOL_ID.manageCanvas, {})
    );
  });
});

describe('namesTool', () => {
  it('is set only on the generic fallbacks whose wording spells the tool id', () => {
    expect(verbForTool('legacy.echo').namesTool).toBe(true);
    expect(verbForTool('mystery_tool').namesTool).toBe(true);
    expect(verbForTool(NATIVE_TOOL_ID.readWorkspaceFile).namesTool).toBeUndefined();
    expect(verbForTool('agent-explore').namesTool).toBeUndefined();
    expect(verbForTool(HOST_META_TOOL_ID.loadTool).namesTool).toBeUndefined();
  });
});
