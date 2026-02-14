import { describe, expect, it } from 'vitest';
import { validateToolInput } from '../tools/schemas';

describe('tool schemas', () => {
  it('validates filesystem.list input', () => {
    const ok = validateToolInput('filesystem.list', { path: '/tmp' });
    expect(ok.ok).toBe(true);
  });

  it('allows missing path for filesystem.list', () => {
    const ok = validateToolInput('filesystem.list', {});
    expect(ok.ok).toBe(true);
  });

  it('validates filesystem.read input', () => {
    const ok = validateToolInput('filesystem.read', {
      path: '/tmp',
      maxBytes: 1024,
      encoding: 'utf8',
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects invalid filesystem.read input', () => {
    const bad = validateToolInput('filesystem.read', { path: '' });
    expect(bad.ok).toBe(false);
  });

  it('passes through unknown tool names', () => {
    const ok = validateToolInput('custom.tool', { x: 1 });
    expect(ok.ok).toBe(true);
  });

  it('validates filesystem.search input', () => {
    const ok = validateToolInput('filesystem.search', { query: 'md', maxResults: 5 });
    expect(ok.ok).toBe(true);
  });

  it('rejects missing query in filesystem.search', () => {
    const bad = validateToolInput('filesystem.search', {} as unknown as { query: string });
    expect(bad.ok).toBe(false);
  });

  it('validates batch workspace selection input', () => {
    const ok = validateToolInput('brainstrike.batchSelectWorkspaceFiles', {
      filePaths: ['/src/main.ts', '/src/utils.ts'],
      mode: 'add',
      selectionTarget: 'both',
    });
    expect(ok.ok).toBe(true);
  });
});
