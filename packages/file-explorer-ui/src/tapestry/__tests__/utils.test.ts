import { TAPESTRY_COLOR_HEX, TAPESTRY_COLOR_NAMES } from '@brainstrike/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTapestryStructureSegments,
  generateColor,
  generateMockFiles,
  generateStructure,
  getTapestryGalleryMetrics,
  getTapestryRenderMetrics,
} from '../utils';

const stubRandomUUIDs = () => {
  let counter = 0;
  const randomUUIDImpl = (): `${string}-${string}-${string}-${string}-${string}` => {
    const suffix = String(++counter).padStart(12, '0');
    return `00000000-0000-4000-8000-${suffix}`;
  };
  const randomUUID = vi.fn(randomUUIDImpl);

  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoRef?.randomUUID) {
    vi.spyOn(cryptoRef, 'randomUUID').mockImplementation(randomUUID);
  } else {
    vi.stubGlobal('crypto', { randomUUID });
  }

  return randomUUID;
};

const stubRandom = (value: number) => {
  vi.spyOn(Math, 'random').mockReturnValue(value);
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tapestry utils', () => {
  it('bounds very large document overviews while preserving line mapping', () => {
    const metrics = getTapestryRenderMetrics(10_000, 4);

    expect(metrics.totalHeight).toBe(640);
    expect(metrics.lineScale).toBeCloseTo(0.064);
  });

  it('maps the gallery scale to coordinated card width, line density, and zoom', () => {
    expect(getTapestryGalleryMetrics(0)).toEqual({
      cardMinWidth: 112,
      gap: 8,
      lineDensity: 1,
      zoomPercent: 50,
    });
    expect(getTapestryGalleryMetrics(4)).toEqual({
      cardMinWidth: 184,
      gap: 12,
      lineDensity: 4,
      zoomPercent: 100,
    });
    expect(getTapestryGalleryMetrics(8)).toEqual({
      cardMinWidth: 256,
      gap: 16,
      lineDensity: 7,
      zoomPercent: 150,
    });
  });

  it('summarizes large structures into a bounded set of ordered segments', () => {
    const structure = Array.from({ length: 10_000 }, (_, index) => ({
      indent: index % 4,
      isEmpty: index % 11 === 0,
      width: (index % 90) + 10,
    }));

    const segments = buildTapestryStructureSegments(structure);

    expect(segments.length).toBeLessThanOrEqual(320);
    expect(segments[0]).toMatchObject({ startLine: 0 });
    expect(segments.at(-1)?.endLine).toBe(10_000);
    expect(
      segments.every((segment, index) =>
        index === 0 ? true : segment.startLine >= (segments[index - 1]?.endLine ?? 0)
      )
    ).toBe(true);
  });

  it('generates structure with empty lines when randomness is high', () => {
    stubRandom(0.95);

    const structure = generateStructure(2);

    expect(structure).toHaveLength(2);
    expect(structure.every((line) => line.isEmpty)).toBe(true);
  });

  it('generates deterministic mock files when randomness is low', () => {
    stubRandom(0);
    const randomUUID = stubRandomUUIDs();
    const firstUuid = '00000000-0000-4000-8000-000000000001';
    const secondUuid = '00000000-0000-4000-8000-000000000002';

    const files = generateMockFiles(1);

    expect(files).toHaveLength(1);
    expect(randomUUID).toHaveBeenCalledTimes(2);
    expect(files[0]?.id).toBe(secondUuid);
    expect(files[0]?.name).toBe('App.tsx');
    expect(files[0]?.language).toBe('tsx');
    expect(files[0]?.totalLines).toBe(50);
    expect(files[0]?.selections[0]).toMatchObject({
      endLine: 50,
      id: firstUuid,
      isActive: true,
      startLine: 0,
    });
    expect(files[0]?.content[0]).toMatch(/^\/\//);
  });

  it('generates mock files with non-comment fragments at mid randomness', () => {
    stubRandom(0.5);
    stubRandomUUIDs();

    const files = generateMockFiles(1);

    expect(files[0]?.content[0]).toBe('}');
  });
});

describe('generateColor (single source of truth)', () => {
  it('derives the auto-assign palette from @brainstrike/types (no hand-synced copy)', () => {
    // The first 8 named colors are the auto-assign palette; `gray` is excluded.
    for (const [index, name] of TAPESTRY_COLOR_NAMES.slice(0, 8).entries()) {
      expect(generateColor(index)).toBe(TAPESTRY_COLOR_HEX[name]);
    }
  });

  it('cycles through the 8-color palette and excludes the de-emphasis gray', () => {
    expect(generateColor(8)).toBe(generateColor(0));
    expect(generateColor(0)).toBe(TAPESTRY_COLOR_HEX.red);
    expect(generateColor(7)).toBe(TAPESTRY_COLOR_HEX.pink);
    // gray (index 8 in the names list) must never be auto-assigned.
    const cycled = Array.from({ length: 16 }, (_, i) => generateColor(i));
    expect(cycled).not.toContain(TAPESTRY_COLOR_HEX.gray);
  });
});
