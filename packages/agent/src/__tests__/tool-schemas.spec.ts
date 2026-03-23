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
