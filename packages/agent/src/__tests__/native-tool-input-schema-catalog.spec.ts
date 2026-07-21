import { describe, expect, it } from 'vitest';
import * as toolSchemas from '../tools/schemas';

const EXPECTED_DESKTOP_NATIVE_TOOL_IDS = [
  'brainstrike.askUser',
  'brainstrike.deleteWorkspaceFile',
  'brainstrike.executeCommand',
  'brainstrike.findWorkspaceSymbol',
  'brainstrike.globWorkspace',
  'brainstrike.grepSearch',
  'brainstrike.hybridSearch',
  'brainstrike.inspectCommandSessions',
  'brainstrike.listEmbeddingSpaces',
  'brainstrike.listWorkspaceContext',
  'brainstrike.lspInspect',
  'brainstrike.manageTaskList',
  'brainstrike.manageCommandSession',
  'brainstrike.queryEmbeddingSpace',
  'brainstrike.readToolOutputArtifact',
  'brainstrike.readWorkspaceContext',
  'brainstrike.readWorkspaceDirectory',
  'brainstrike.readWorkspaceFile',
  'brainstrike.renameWorkspaceFile',
  'brainstrike.stringReplaceWorkspaceFile',
  'brainstrike.submitPlan',
  'brainstrike.updateWorkspaceContextSelection',
  'brainstrike.updateWorkspaceTapestrySelections',
  'brainstrike.webExtract',
  'brainstrike.webSearch',
  'brainstrike.writeWorkspaceFile',
] as const;

describe('native tool input schema catalog', () => {
  it('exports exact desktop-native parity without stale web or Mastra-owned skill entries', () => {
    const registry = Reflect.get(toolSchemas, 'NATIVE_TOOL_INPUT_SCHEMAS');
    expect(
      registry,
      'NATIVE_TOOL_INPUT_SCHEMAS must be the exported agent-only Zod schema source'
    ).toEqual(expect.any(Object));
    if (!(registry && typeof registry === 'object')) {
      throw new TypeError('NATIVE_TOOL_INPUT_SCHEMAS must be an object');
    }

    expect(Object.keys(registry).sort()).toEqual([...EXPECTED_DESKTOP_NATIVE_TOOL_IDS].sort());
    expect(registry).not.toHaveProperty('web.echo');
    expect(registry).not.toHaveProperty('skill');
    expect(registry).not.toHaveProperty('skill_read');
    expect(registry).not.toHaveProperty('skill_search');
  });

  it('accepts compact hosted-provider continuations and rejects identity overrides', () => {
    const schema = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.readWorkspaceFile'];
    const cursor = 'rfh_abcdefghijklmnopqrstuv';

    expect(schema.safeParse({ path: '/src/main.ts' }).success).toBe(true);
    expect(schema.safeParse({ cursor, maxChars: 6000 }).success).toBe(true);
    expect(
      schema.safeParse({
        cursor,
        endLine: 77,
        maxChars: 6000,
        path: null,
        root: null,
        startLine: null,
      }).success
    ).toBe(true);
    expect(schema.safeParse({ cursor, path: '/src/main.ts' }).success).toBe(false);
    expect(schema.safeParse({ cursor, root: 'other-root' }).success).toBe(false);
  });

  it('keeps command-session inspection separate from execute-risk management', () => {
    const inspect = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.inspectCommandSessions'];
    const manage = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.manageCommandSession'];

    expect(inspect.safeParse({ operation: { action: 'list' }, root: 'api' }).success).toBe(true);
    expect(
      inspect.safeParse({
        operation: { action: 'read', cursor: -1, sessionId: 'session-1' },
        root: 'api',
      }).success
    ).toBe(true);
    expect(
      inspect.safeParse({ operation: { action: 'stop', sessionId: 'session-1' } }).success
    ).toBe(false);
    expect(inspect.safeParse({ action: 'list', cursor: 0 }).success).toBe(false);
    expect(inspect.safeParse({ operation: { action: 'list', sessionId: 'ignored' } }).success).toBe(
      false
    );

    expect(
      manage.safeParse({ operation: { action: 'start', command: 'pnpm dev' }, root: 'api' }).success
    ).toBe(true);
    expect(
      manage.safeParse({ operation: { action: 'write', data: 'q\n', sessionId: 'session-1' } })
        .success
    ).toBe(true);
    expect(
      manage.safeParse({ operation: { action: 'stop', sessionId: 'session-1' } }).success
    ).toBe(true);
    expect(
      manage.safeParse({ operation: { action: 'remove', sessionId: 'session-1' } }).success
    ).toBe(true);
    expect(
      manage.safeParse({ operation: { action: 'read', sessionId: 'session-1' } }).success
    ).toBe(false);
    expect(
      manage.safeParse({ operation: { action: 'start', command: 'pnpm dev', data: 'ignored' } })
        .success
    ).toBe(false);
    expect(
      manage.safeParse({
        operation: { action: 'write', command: 'ignored', data: 'q', sessionId: 'session-1' },
      }).success
    ).toBe(false);
    expect(
      manage.safeParse({ operation: { action: 'stop', cwd: 'ignored', sessionId: 'session-1' } })
        .success
    ).toBe(false);
  });
});
