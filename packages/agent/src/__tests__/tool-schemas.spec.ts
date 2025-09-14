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

  it('passes through unknown tool names', () => {
    const ok = validateToolInput('custom.tool', { x: 1 });
    expect(ok.ok).toBe(true);
  });
});
