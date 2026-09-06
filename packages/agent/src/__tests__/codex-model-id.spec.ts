import { describe, expect, it } from 'vitest';
import { CODEX_MODEL_ID_PREFIX, resolveCodexModelId } from '../providers/codex-model-id';

/**
 * Catalog id -> wire id for the ChatGPT-subscription provider (BST-1356).
 *
 * The catalog stores `codex/`-prefixed ids because the `models` table's `id`
 * is a GLOBAL primary key and a bare `gpt-5.5` would collide with the
 * platform `openai` row. The Codex backend expects the BARE id, so the prefix
 * is stripped here — the mirror of bedrock's `resolveBedrockModelId`.
 */

describe('resolveCodexModelId', () => {
  it('strips the catalog prefix to the bare wire id', () => {
    expect(resolveCodexModelId('codex/gpt-5.5')).toBe('gpt-5.5');
    expect(resolveCodexModelId('codex/gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(resolveCodexModelId('codex/gpt-5.3-codex-spark')).toBe('gpt-5.3-codex-spark');
  });

  it('exposes the prefix it strips', () => {
    expect(CODEX_MODEL_ID_PREFIX).toBe('codex/');
  });

  it('strips only the leading prefix, never an inner occurrence', () => {
    expect(resolveCodexModelId('codex/nested-codex/model')).toBe('nested-codex/model');
  });

  it('rejects an unprefixed id instead of silently passing it through', () => {
    // A bare id here means the catalog and this resolver disagree — sending
    // it anyway would work by accident today and break silently later.
    expect(() => resolveCodexModelId('gpt-5.5')).toThrow(/codex\//);
  });

  it('rejects an empty wire id', () => {
    expect(() => resolveCodexModelId('codex/')).toThrow();
  });
});
