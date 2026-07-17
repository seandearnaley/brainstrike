import { describe, expect, it } from 'vitest';
import { mapCrossRootUsageRow } from '../assistant-memory-repository';

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputTokens: 100,
    model: 'claude-opus-4-8',
    outputTokens: 50,
    provider: 'anthropic',
    rootDisplayName: 'project-alpha',
    rootId: 'root-1',
    ...overrides,
  };
}

describe('mapCrossRootUsageRow', () => {
  it('maps a well-formed row', () => {
    expect(mapCrossRootUsageRow(baseRow())).toMatchObject({
      inputTokens: 100,
      model: 'claude-opus-4-8',
      outputTokens: 50,
      provider: 'anthropic',
      rootDisplayName: 'project-alpha',
      rootId: 'root-1',
    });
  });

  it('keeps a NULL rootDisplayName null (LEFT JOIN miss)', () => {
    expect(mapCrossRootUsageRow(baseRow({ rootDisplayName: null })).rootDisplayName).toBeNull();
  });

  it('bounds an oversized rootDisplayName to 512 chars (mapper defense; the SQL also SUBSTRs)', () => {
    const huge = 'x'.repeat(5000);
    expect(mapCrossRootUsageRow(baseRow({ rootDisplayName: huge })).rootDisplayName).toHaveLength(
      512
    );
  });

  it('bounds by code points, never splitting a surrogate pair at the boundary', () => {
    // Each emoji is a surrogate PAIR in UTF-16; a naive `.slice(0, 512)` would
    // cut mid-pair and leave a lone surrogate. Code-point slicing keeps 512 whole
    // emoji (mirrors the SQL SUBSTR's character semantics).
    const emoji = '😀'.repeat(600);
    const name = mapCrossRootUsageRow(baseRow({ rootDisplayName: emoji })).rootDisplayName ?? '';
    expect([...name]).toHaveLength(512);
    expect(name).toBe('😀'.repeat(512));
  });
});
