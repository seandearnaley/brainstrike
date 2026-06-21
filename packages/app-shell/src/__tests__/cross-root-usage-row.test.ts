import { describe, expect, it } from 'vitest';
import { mapCrossRootUsageRow } from '../assistant-memory-repository';

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rootId: 'root-1',
    rootDisplayName: 'project-alpha',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

describe('mapCrossRootUsageRow', () => {
  it('maps a well-formed row', () => {
    expect(mapCrossRootUsageRow(baseRow())).toMatchObject({
      rootId: 'root-1',
      rootDisplayName: 'project-alpha',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 50,
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
});
