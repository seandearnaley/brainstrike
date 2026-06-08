import { describe, expect, it } from 'vitest';
import { getToolSchemaDisplay } from '../registry/tool-schemas-display';
import { UpdateWorkspaceTapestrySelectionsInputSchema, validateToolInput } from '../tools/schemas';

describe('tool schemas', () => {
  it('passes through unknown tool names', () => {
    const ok = validateToolInput('custom.tool', { x: 1 });
    expect(ok.ok).toBe(true);
  });

  it('does not special-case legacy filesystem aliases', () => {
    const ok = validateToolInput('filesystem.list', { path: '' });
    expect(ok.ok).toBe(true);
  });

  it('does not advertise legacy filesystem aliases in schema display metadata', () => {
    expect(getToolSchemaDisplay('filesystem.list')).toBeUndefined();
  });

  it('validates workspace context read input', () => {
    const ok = validateToolInput('brainstrike.readWorkspaceContext', {
      filePaths: ['/src/main.ts', '/src/utils.ts'],
      maxFiles: 2,
      tokenBudget: 4000,
      useTapestrySelections: true,
    });
    expect(ok.ok).toBe(true);
  });

  it('validates workspace context selection updates', () => {
    const ok = validateToolInput('brainstrike.updateWorkspaceContextSelection', {
      filePaths: ['/src/main.ts', '/src/utils.ts'],
      mode: 'replace',
    });
    expect(ok.ok).toBe(true);
  });

  it('validates workspace tapestry selection updates', () => {
    const ok = validateToolInput('brainstrike.updateWorkspaceTapestrySelections', {
      mode: 'replace',
      selectFiles: true,
      updates: [
        {
          path: '/src/main.ts',
          ranges: [{ startLine: 4, endLine: 12, isActive: true }],
        },
      ],
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects inverted workspace tapestry ranges', () => {
    const ok = validateToolInput('brainstrike.updateWorkspaceTapestrySelections', {
      updates: [
        {
          path: '/src/main.ts',
          ranges: [{ startLine: 12, endLine: 4 }],
        },
      ],
    });
    expect(ok.ok).toBe(false);
  });

  it('allows embedding-space queries to omit an explicit id for workspace-index defaulting', () => {
    const ok = validateToolInput('brainstrike.queryEmbeddingSpace', {
      query: 'where is context assembled?',
    });
    expect(ok.ok).toBe(true);
  });

  it('validates workspace-index embedding-space listing input', () => {
    const ok = validateToolInput('brainstrike.listEmbeddingSpaces', {
      includeStats: true,
      workspaceIndexOnly: true,
    });
    expect(ok.ok).toBe(true);
  });

  it('marks embedding set id as optional in query display metadata', () => {
    const schema = getToolSchemaDisplay('brainstrike.queryEmbeddingSpace');
    const embeddingSetParam = schema?.parameters.find((param) => param.name === 'embeddingSetId');
    expect(embeddingSetParam?.required).toBe(false);
  });

  it('documents workspace-index filtering for embedding-space listing', () => {
    const schema = getToolSchemaDisplay('brainstrike.listEmbeddingSpaces');
    const workspaceIndexOnly = schema?.parameters.find(
      (param) => param.name === 'workspaceIndexOnly'
    );
    expect(workspaceIndexOnly?.type).toBe('boolean');
  });

  it('documents context curation tools in schema display metadata', () => {
    expect(getToolSchemaDisplay('brainstrike.updateWorkspaceContextSelection')).toBeDefined();
    expect(getToolSchemaDisplay('brainstrike.updateWorkspaceTapestrySelections')).toBeDefined();
  });
});

describe('UpdateWorkspaceTapestrySelectionsInputSchema color', () => {
  const base = {
    updates: [{ path: '/a.ts', ranges: [{ startLine: 1, endLine: 3 }] }],
  };

  it('accepts an omitted color', () => {
    expect(UpdateWorkspaceTapestrySelectionsInputSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a valid named color', () => {
    const input = {
      updates: [{ path: '/a.ts', ranges: [{ startLine: 1, endLine: 3, color: 'blue' }] }],
    };
    expect(UpdateWorkspaceTapestrySelectionsInputSchema.safeParse(input).success).toBe(true);
  });

  it('rejects an unknown color name (no silent fallback)', () => {
    const input = {
      updates: [{ path: '/a.ts', ranges: [{ startLine: 1, endLine: 3, color: 'chartreuse' }] }],
    };
    expect(UpdateWorkspaceTapestrySelectionsInputSchema.safeParse(input).success).toBe(false);
  });
});
