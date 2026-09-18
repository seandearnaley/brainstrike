import {
  getChunkingPreset as contractGetChunkingPreset,
  getChunkingPresetDefinitions as contractGetChunkingPresetDefinitions,
  getChunkingRoutePreview as contractGetChunkingRoutePreview,
  isChunkingStrategy as contractIsChunkingStrategy,
  isResolvedChunkingStrategy as contractIsResolvedChunkingStrategy,
  resolveChunkingStrategyForFile as contractResolveChunkingStrategyForFile,
  resolveEffectiveChunkingStrategy as contractResolveEffectiveChunkingStrategy,
} from '@brainstrike/indexing-contract';
import { describe, expect, it } from 'vitest';
import {
  getChunkingPreset,
  getChunkingPresetDefinitions,
  getChunkingRoutePreview,
  isChunkingStrategy,
  isResolvedChunkingStrategy,
  resolveChunkingStrategyForFile,
  resolveEffectiveChunkingStrategy,
} from '../index.js';

/**
 * BST-1144 parity guard: the chunking-policy surface re-exported from
 * `@brainstrike/text-splitter` must be exactly `@brainstrike/indexing-contract`'s
 * canonical implementation.
 *
 * RED: while the two packages carried independent copies, the deep-equality
 * assertions below failed on the straight-vs-curly apostrophe drift in one
 * CHUNKING_PRESETS tradeoff string — proving no test guarded their sync.
 * GREEN: both packages consume the single canonical source, so the surfaces
 * cannot diverge silently. If anyone reintroduces a local copy here, the
 * identity assertions fail first.
 */
describe('chunking-policy parity with @brainstrike/indexing-contract (BST-1144)', () => {
  it('re-exports the canonical function identities', () => {
    expect(getChunkingPreset).toBe(contractGetChunkingPreset);
    expect(getChunkingPresetDefinitions).toBe(contractGetChunkingPresetDefinitions);
    expect(getChunkingRoutePreview).toBe(contractGetChunkingRoutePreview);
    expect(isChunkingStrategy).toBe(contractIsChunkingStrategy);
    expect(isResolvedChunkingStrategy).toBe(contractIsResolvedChunkingStrategy);
    expect(resolveChunkingStrategyForFile).toBe(contractResolveChunkingStrategyForFile);
    expect(resolveEffectiveChunkingStrategy).toBe(contractResolveEffectiveChunkingStrategy);
  });

  it('preset definitions are deeply equal (catches data drift)', () => {
    expect(getChunkingPresetDefinitions()).toEqual(contractGetChunkingPresetDefinitions());
    for (const preset of getChunkingPresetDefinitions()) {
      expect(getChunkingPreset(preset.id)).toEqual(contractGetChunkingPreset(preset.id));
    }
    expect(() => getChunkingPreset('no-such-preset' as never)).toThrow(
      'Unknown chunking preset: no-such-preset'
    );
  });

  it('strategy resolution agrees across a representative file matrix', () => {
    const files = [
      'src/assistant/retrieval.ts',
      'src/worker/chunking.worker.ts',
      'app/main.py',
      'docs/getting-started.md',
      'docs/guide.rst',
      'schemas/search-response.json',
      'data/records.jsonl',
      'public/reference/index.html',
      'notes/retrieval-paper.tex',
      'notes/retro.txt',
      'Makefile',
      '.gitignore',
      'archive.tar.gz',
      'src/nested/deep/module.tsx',
    ];
    for (const file of files) {
      expect(resolveChunkingStrategyForFile(file)).toBe(
        contractResolveChunkingStrategyForFile(file)
      );
      expect(resolveChunkingStrategyForFile(file, 'markdown')).toBe(
        contractResolveChunkingStrategyForFile(file, 'markdown')
      );
    }
  });

  it('route previews agree for default and explicit strategies', () => {
    expect(getChunkingRoutePreview()).toEqual(contractGetChunkingRoutePreview());
    expect(getChunkingRoutePreview('token')).toEqual(contractGetChunkingRoutePreview('token'));
  });

  it('effective-strategy resolution agrees on the decision matrix', () => {
    const cases = [
      { isCode: true, requested: 'auto' as const, resolvedAutoStrategy: 'recursive' as const },
      { isCode: false, requested: 'auto' as const, resolvedAutoStrategy: 'recursive' as const },
      { isCode: false, requested: 'auto' as const, resolvedAutoStrategy: 'sentence' as const },
      { isCode: true, requested: 'markdown' as const, resolvedAutoStrategy: 'sentence' as const },
    ];
    for (const c of cases) {
      expect(resolveEffectiveChunkingStrategy(c)).toBe(contractResolveEffectiveChunkingStrategy(c));
    }
  });

  it('strategy guards agree on edge inputs', () => {
    const inputs: unknown[] = [
      'auto',
      'markdown',
      'sentence',
      'bogus',
      '',
      null,
      undefined,
      42,
      {},
      'MARKDOWN',
    ];
    for (const input of inputs) {
      expect(isChunkingStrategy(input)).toBe(contractIsChunkingStrategy(input));
      expect(isResolvedChunkingStrategy(input)).toBe(contractIsResolvedChunkingStrategy(input));
    }
  });
});
