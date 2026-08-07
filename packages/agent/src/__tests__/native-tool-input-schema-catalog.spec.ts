import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
  'brainstrike.manageCanvas',
  'brainstrike.manageTaskList',
  'brainstrike.manageCommandSession',
  'brainstrike.queryEmbeddingSpace',
  'brainstrike.queryDiagnostics',
  'brainstrike.querySelf',
  'brainstrike.readToolOutputArtifact',
  'brainstrike.readWorkspaceContext',
  'brainstrike.readWorkspaceDirectory',
  'brainstrike.readWorkspaceFile',
  'brainstrike.renameWorkspaceFile',
  'brainstrike.runPython',
  'brainstrike.runSkillScript',
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

  it('validates the manageCanvas action union, tolerating cross-action extras (model-idiomatic)', () => {
    const schema = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.manageCanvas'];

    expect(
      schema.safeParse({ action: 'create', html: '<p>Hello</p>', title: 'Draft' }).success
    ).toBe(true);
    expect(
      schema.safeParse({
        action: 'update',
        canvasId: 'canvas-1',
        newString: 'new',
        oldString: 'old',
      }).success
    ).toBe(true);
    expect(schema.safeParse({ action: 'rewrite', canvasId: 'canvas-1', html: '' }).success).toBe(
      true
    );
    expect(schema.safeParse({ action: 'list' }).success).toBe(true);

    // Cross-action EXTRAS among the six declared keys are tolerated: `action`
    // fully determines semantics, and real models bundle fields (observed live
    // with gpt-5.6 on 2026-08-07 — both payloads below are verbatim from the
    // production failure). Rejecting them broke the feature and burned retry
    // tokens.
    expect(
      schema.safeParse({
        action: 'create',
        canvasId: 'redundant',
        html: '<h1>Report</h1>',
        newString: 'b',
        oldString: 'a',
        title: 'Report',
      }).success
    ).toBe(true);
    expect(
      schema.safeParse({
        action: 'list',
        canvasId: 'c',
        html: 'x',
        newString: 'n',
        oldString: 'o',
        title: 't',
      }).success
    ).toBe(true);

    // Missing REQUIRED fields for the chosen action still fail…
    expect(
      schema.safeParse({ action: 'update', canvasId: 'canvas-1', oldString: 'old' }).success
    ).toBe(false);
    // …as do unknown actions and genuinely unknown keys (hallucinated API —
    // the strict envelope still catches those).
    expect(schema.safeParse({ action: 'unknown' }).success).toBe(false);
    expect(
      schema.safeParse({ action: 'create', content: 'nope', html: '', title: 'x' }).success
    ).toBe(false);
  });

  it('keeps command-session inspection separate from execute-risk management', () => {
    const inspect = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.inspectCommandSessions'];
    const manage = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.manageCommandSession'];

    expect(inspect.safeParse({ operation: { action: 'list' }, root: 'api' }).success).toBe(true);
    expect(
      inspect.safeParse({ operation: { action: 'list', offset: 25 }, root: 'api' }).success
    ).toBe(true);
    expect(inspect.safeParse({ operation: { action: 'list', offset: -1 } }).success).toBe(false);
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

  it('requires an explicit diagnostics query mode and bounds its filters', () => {
    const schema = toolSchemas.NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.queryDiagnostics'];

    expect(schema.safeParse({ mode: 'events' }).success).toBe(true);
    expect(
      schema.safeParse({
        fingerprint: 'fp-provider',
        limit: 100,
        mode: 'fingerprints',
        severity: 'error',
        since: '2026-07-20T00:00:00.000Z',
        threadId: 'thread-1',
        until: '2026-07-28T00:00:00.000Z',
      }).success
    ).toBe(true);
    expect(schema.safeParse({ limit: 201, mode: 'events' }).success).toBe(false);
    expect(schema.safeParse({ mode: 'unknown' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(JSON.stringify(z.toJSONSchema(schema))).not.toContain('"pattern"');
  });
});
