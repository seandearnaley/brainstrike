import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import { projectListWorkspaceContextModelOutput } from '../src/native-tools/workspace-context-model-projection.ts';

function serializedChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function baseResult() {
  return {
    workspaceRootPath: '/work/brainstrike',
    workspaceRoots: [
      { displayName: 'brainstrike', path: '/work/brainstrike', rootId: 'root-a' },
      { displayName: 'docs', path: '/work/docs', rootId: 'root-b' },
    ],
  };
}

describe('workspace context model projection', () => {
  it('projects an authoritative zero-root result without inventing a main root', () => {
    const projected = projectListWorkspaceContextModelOutput({
      workspaceRootPath: null,
      workspaceRoots: [],
    });

    expect(projected).toEqual({ type: 'text', value: 'workspace context | roots=0 | main=none' });
  });

  it('projects the main root first, then the other roots', () => {
    expect(projectListWorkspaceContextModelOutput(baseResult())).toEqual({
      type: 'text',
      value: [
        'workspace context | roots=2 | main=/work/brainstrike',
        'root main | name=brainstrike | id=root-a | path=/work/brainstrike',
        'root | name=docs | id=root-b | path=/work/docs',
      ].join('\n'),
    });
  });

  it('keeps the main root and says how many other roots did not fit the budget', () => {
    const workspaceRoots = Array.from({ length: 120 }, (_, index) => ({
      displayName: `root-${index}`,
      path: `/work/${'nested/'.repeat(20)}root-${index}`,
      rootId: `root-${index}`,
    }));
    const raw = {
      ...baseResult(),
      workspaceRootPath: workspaceRoots[0]?.path ?? null,
      workspaceRoots,
    };

    const projected = projectListWorkspaceContextModelOutput(raw);

    expect(serializedChars(raw)).toBeGreaterThan(MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET);
    expect(serializedChars(projected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projected.value).toContain('root main | name=root-0');
    const kept = projected.value.split('\n').filter((line) => line.startsWith('root |')).length;
    expect(projected.value).toContain(`projection_omitted: roots=${119 - kept}`);
  });

  it('escapes path line breaks without collapsing other path whitespace', () => {
    const path = '/work/foo  bar\r\nline separator root';
    const projected = projectListWorkspaceContextModelOutput({
      ...baseResult(),
      workspaceRootPath: path,
      workspaceRoots: [{ displayName: 'odd', path, rootId: 'root-odd' }],
    });

    expect(projected.value).toContain(
      String.raw`root main | name=odd | id=root-odd | path=/work/foo  bar\r\nline\u2028separator\u2029root`
    );
  });

  it('throws visibly for malformed producer results', () => {
    expect(() => projectListWorkspaceContextModelOutput({ workspaceRoots: [] })).toThrow(
      'listWorkspaceContext model projection received a malformed result'
    );
    // The main path is the first root's, never a focused or invented one.
    expect(() =>
      projectListWorkspaceContextModelOutput({ ...baseResult(), workspaceRootPath: '/work/docs' })
    ).toThrow('listWorkspaceContext model projection received a malformed result');
    expect(() =>
      projectListWorkspaceContextModelOutput({
        ...baseResult(),
        workspaceRootPath: null,
        workspaceRoots: [],
      })
    ).not.toThrow();
  });
});
