import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import { projectListWorkspaceContextModelOutput } from '../../assistant-server/workspace-context-model-projection';

function serializedChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function baseResult() {
  return {
    offset: 0,
    selectedFileCount: 2,
    selectedFiles: ['/src/main.ts', '/README.md'],
    selectionFolderId: 'root-a',
    truncated: false,
    workspaceIndex: {
      embeddingSetId: 'workspace-index',
      enabled: true,
      mode: 'root-folder-cache',
      paused: false,
    },
    workspaceRootPath: '/work/brainstrike',
    workspaceRoots: [
      { displayName: 'brainstrike', path: '/work/brainstrike', rootId: 'root-a' },
      { displayName: 'docs', path: '/work/docs', rootId: 'root-b' },
    ],
  };
}

describe('workspace context model projection', () => {
  it('projects a concise multi-root selection with index and curated-token state', () => {
    const raw = {
      ...baseResult(),
      curatedContextSummary: {
        fileCount: 2,
        includeProjectTree: false,
        projectTreeApproxTokens: 1800,
        rangeCount: 1,
        selectedOutputApproxTokens: 140,
        selectedSourceApproxTokens: 240,
        tokenBudget: 8192,
      },
      selectedFilesOutsideWorkspace: 4,
      tokenEstimates: [
        { approxTokens: 200, path: '/src/main.ts' },
        { approxTokens: null, path: '/README.md' },
      ],
    };

    expect(projectListWorkspaceContextModelOutput(raw)).toEqual({
      type: 'text',
      value: [
        'workspace context | main=/work/brainstrike | selected=2 | outside=4 | page=1-2/2 | truncated=false | focused_root_id=root-a',
        'index | enabled=true | paused=false | mode=root-folder-cache | embedding_set=workspace-index',
        'root main | name=brainstrike | id=root-a | path=/work/brainstrike',
        'root | name=docs | id=root-b | path=/work/docs',
        'selected /src/main.ts | approx_tokens=200',
        'selected /README.md | approx_tokens=unavailable',
        'curated | files=2 | ranges=1 | budget=8192 | selected_source_tokens=240 | selected_output_tokens=140 | project_tree=false | project_tree_tokens=1800',
      ].join('\n'),
    });
  });

  it('self-fits a large selected-file page with an exact earlier advancing offset', () => {
    const selectedFiles = Array.from(
      { length: 90 },
      (_, index) => `/packages/domain-${index}/${'nested/'.repeat(25)}file-${index}.ts`
    );
    const raw = {
      ...baseResult(),
      hint: 'Showing selected files 41-130 of 500. Continue with offset: 130.',
      offset: 40,
      selectedFileCount: 500,
      selectedFiles,
      tokenEstimates: selectedFiles.map((path, index) => ({
        approxTokens: index % 3 === 0 ? null : index * 10,
        path,
      })),
      truncated: true,
    };

    const projected = projectListWorkspaceContextModelOutput(raw);
    const match = projected.value.match(/continue: reuse the prior .* offset=(\d+)/);

    expect(serializedChars(raw)).toBeGreaterThan(MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET);
    expect(serializedChars(projected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(serializedChars(projected)).toBeLessThan(serializedChars(raw) * 0.7);
    expect(projected.value).toContain('projection_omitted:');
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(40);
    expect(Number(match?.[1])).toBeLessThan(130);
  });

  it('compacts detailed curated files and their Tapestry ranges', () => {
    const raw = {
      ...baseResult(),
      curatedContext: {
        files: [
          {
            approxTokens: 200,
            outputApproxTokens: 100,
            path: '/src/main.ts',
            ranges: [
              { approxTokens: 20, endLine: 3, isActive: true, startLine: 2 },
              { approxTokens: null, endLine: 18, isActive: false, startLine: 10 },
            ],
            rootDisplayName: 'brainstrike',
            rootId: 'root-a',
          },
        ],
        includeProjectTree: true,
        projectTreeApproxTokens: null,
        projectTreeTokenCountLoading: true,
        selectedOutputApproxTokens: 100,
        selectedSourceApproxTokens: 200,
        tokenBudget: 4096,
      },
    };

    const projected = projectListWorkspaceContextModelOutput(raw);

    expect(projected.value).toContain(
      'curated detail | files=1 | ranges=2 | budget=4096 | selected_source_tokens=200 | selected_output_tokens=100 | project_tree=true | project_tree_tokens=unavailable | project_tree_loading=true'
    );
    expect(projected.value).toContain(
      'context_file 1 | root=brainstrike|root-a | path=/src/main.ts | source_tokens=200 | output_tokens=100 | ranges=2'
    );
    expect(projected.value).toContain('range 1.1 | lines=2-3 | active=true | approx_tokens=20');
    expect(projected.value).toContain(
      'range 1.2 | lines=10-18 | active=false | approx_tokens=unavailable'
    );
  });

  it('makes zero selection and disabled or paused indexing explicit', () => {
    const raw = {
      ...baseResult(),
      selectedFileCount: 0,
      selectedFiles: [],
      selectionFolderId: undefined,
      workspaceIndex: {
        embeddingSetId: null,
        enabled: false,
        mode: null,
        paused: true,
      },
    };

    const projected = projectListWorkspaceContextModelOutput(raw);

    expect(projected.value).toContain('selected=0 | outside=0 | page=empty/0');
    expect(projected.value).toContain(
      'index | enabled=false | paused=true | mode=unavailable | embedding_set=unavailable'
    );
  });

  it('throws visibly for malformed or non-advancing producer results', () => {
    expect(() =>
      projectListWorkspaceContextModelOutput({
        ...baseResult(),
        selectedFileCount: -1,
      })
    ).toThrow('listWorkspaceContext model projection received a malformed result');

    expect(() =>
      projectListWorkspaceContextModelOutput({
        ...baseResult(),
        hint: 'Continue with offset: 0.',
        selectedFileCount: 3,
        selectedFiles: [],
        truncated: true,
      })
    ).toThrow('listWorkspaceContext truncated without an advancing selected-file page');
  });
});
