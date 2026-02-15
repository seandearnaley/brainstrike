import { describe, expect, it } from 'vitest';
import { getToolSchemaDisplay } from '../registry/tool-schemas-display';
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

  it('validates root-tree selection input', () => {
    const ok = validateToolInput('brainstrike.selectRootTreeFiles', {
      filePaths: ['/src/main.ts', '/src/utils.ts'],
      mode: 'add',
    });
    expect(ok.ok).toBe(true);
  });

  it('validates preview-context selection input', () => {
    const ok = validateToolInput('brainstrike.updatePreviewContextFiles', {
      filePaths: ['/src/main.ts'],
      mode: 'remove',
    });
    expect(ok.ok).toBe(true);
  });

  it('uses add as the preview-context default mode in display metadata', () => {
    const schema = getToolSchemaDisplay('brainstrike.updatePreviewContextFiles');
    const modeParam = schema?.parameters.find((param) => param.name === 'mode');
    expect(modeParam?.default).toBe('add');
  });
});
