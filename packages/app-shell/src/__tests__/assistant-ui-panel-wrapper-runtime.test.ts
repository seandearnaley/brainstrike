import { describe, expect, it } from 'vitest';
import { buildAssistantTapestryRange } from '../assistant-ui-panel-wrapper-runtime';

describe('buildAssistantTapestryRange color', () => {
  const base = {
    compositeKey: 'folder::/a.ts',
    endLine: 3,
    index: 0,
    isActive: true,
    startLine: 1,
  };

  it('uses the resolved hex when a named color is provided', () => {
    const range = buildAssistantTapestryRange({ ...base, color: 'blue' });
    expect(range.color).toBe('#3b82f6');
  });

  it('falls back to the deterministic color when color is omitted', () => {
    const range = buildAssistantTapestryRange(base);
    expect(range.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
