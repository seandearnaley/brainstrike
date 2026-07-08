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
          ranges: [{ endLine: 12, isActive: true, startLine: 4 }],
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
          ranges: [{ endLine: 4, startLine: 12 }],
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

  it('validates globWorkspace input and rejects unknown fields (strict)', () => {
    expect(validateToolInput('brainstrike.globWorkspace', { pattern: '**/*.ts' }).ok).toBe(true);
    expect(
      validateToolInput('brainstrike.globWorkspace', {
        includeIgnored: true,
        limit: 50,
        offset: 0,
        pattern: 'src/**',
        root: 'app',
      }).ok
    ).toBe(true);
    // Missing required pattern → invalid.
    expect(validateToolInput('brainstrike.globWorkspace', {}).ok).toBe(false);
    // Unknown field → rejected by .strict().
    expect(
      validateToolInput('brainstrike.globWorkspace', { bogus: true, pattern: '*.ts' }).ok
    ).toBe(false);
  });

  it('documents globWorkspace in schema display metadata', () => {
    const display = getToolSchemaDisplay('brainstrike.globWorkspace');
    expect(display).toBeDefined();
    expect(display?.parameters.find((param) => param.name === 'pattern')?.required).toBe(true);
    expect(display?.parameters.find((param) => param.name === 'includeIgnored')?.type).toBe(
      'boolean'
    );
  });

  it('executeCommand description reflects the per-call approval flow (no stale "no approval prompt" text)', () => {
    const display = getToolSchemaDisplay('brainstrike.executeCommand');
    expect(display).toBeDefined();
    const desc = (display?.description ?? '').toLowerCase();
    // The approval flow shipped — the description must not claim otherwise.
    expect(desc).not.toContain('no interactive approval prompt');
    expect(desc).not.toContain('gating is available but off');
    expect(desc).toContain('approval');
  });

  it('rejects an invalid regex grepSearch pattern at parse when isRegex=true (fail-fast)', () => {
    // A regex-special string is fine as PLAIN text (isRegex omitted/false).
    expect(validateToolInput('brainstrike.grepSearch', { pattern: 'a(b' }).ok).toBe(true);
    // A valid regex with isRegex=true is accepted.
    expect(
      validateToolInput('brainstrike.grepSearch', { isRegex: true, pattern: 'foo.*bar' }).ok
    ).toBe(true);
    // An INVALID regex with isRegex=true is rejected at parse — not deferred to execution
    // (fail-fast / no silent fallback).
    expect(validateToolInput('brainstrike.grepSearch', { isRegex: true, pattern: 'a(b' }).ok).toBe(
      false
    );
    expect(
      validateToolInput('brainstrike.grepSearch', { isRegex: true, pattern: '[z-a]' }).ok
    ).toBe(false);
  });

  it('validates webSearch input and rejects unknown fields (strict)', () => {
    expect(validateToolInput('brainstrike.webSearch', { query: 'react useEffect' }).ok).toBe(true);
    expect(
      validateToolInput('brainstrike.webSearch', { maxResults: 3, query: 'react useEffect' }).ok
    ).toBe(true);
    // Missing required query → invalid.
    expect(validateToolInput('brainstrike.webSearch', {}).ok).toBe(false);
    // maxResults over the cap → invalid.
    expect(validateToolInput('brainstrike.webSearch', { maxResults: 50, query: 'x y' }).ok).toBe(
      false
    );
    // Unknown field → rejected by .strict().
    expect(validateToolInput('brainstrike.webSearch', { bogus: true, query: 'react' }).ok).toBe(
      false
    );
  });

  it('documents webSearch in schema display metadata with the external-service caveat', () => {
    const display = getToolSchemaDisplay('brainstrike.webSearch');
    expect(display).toBeDefined();
    expect(display?.parameters.find((param) => param.name === 'query')?.required).toBe(true);
    expect(display?.description).toContain('EXTERNAL SERVICE');
  });

  it('documents context curation tools in schema display metadata', () => {
    expect(getToolSchemaDisplay('brainstrike.updateWorkspaceContextSelection')).toBeDefined();
    expect(getToolSchemaDisplay('brainstrike.updateWorkspaceTapestrySelections')).toBeDefined();
  });
});

describe('UpdateWorkspaceTapestrySelectionsInputSchema color', () => {
  const base = {
    updates: [{ path: '/a.ts', ranges: [{ endLine: 3, startLine: 1 }] }],
  };

  it('accepts an omitted color', () => {
    expect(UpdateWorkspaceTapestrySelectionsInputSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a valid named color', () => {
    const input = {
      updates: [{ path: '/a.ts', ranges: [{ color: 'blue', endLine: 3, startLine: 1 }] }],
    };
    expect(UpdateWorkspaceTapestrySelectionsInputSchema.safeParse(input).success).toBe(true);
  });

  it('rejects an unknown color name (no silent fallback)', () => {
    const input = {
      updates: [{ path: '/a.ts', ranges: [{ color: 'chartreuse', endLine: 3, startLine: 1 }] }],
    };
    expect(UpdateWorkspaceTapestrySelectionsInputSchema.safeParse(input).success).toBe(false);
  });
});
