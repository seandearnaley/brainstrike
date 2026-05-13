import { describe, expect, it } from 'vitest';
import { getToolSchemaDisplay } from '../registry/tool-schemas-display';
import { validateToolInput } from '../tools/schemas';

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
    });
    expect(ok.ok).toBe(true);
  });

  it('requires an explicit embedding set for embedding-space queries', () => {
    const ok = validateToolInput('brainstrike.queryEmbeddingSpace', {
      query: 'where is context assembled?',
    });
    expect(ok.ok).toBe(false);
  });

  it('marks embedding set id as required in query display metadata', () => {
    const schema = getToolSchemaDisplay('brainstrike.queryEmbeddingSpace');
    const embeddingSetParam = schema?.parameters.find((param) => param.name === 'embeddingSetId');
    expect(embeddingSetParam?.required).toBe(true);
  });
});
