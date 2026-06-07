import { TAPESTRY_COLOR_HEX, TAPESTRY_COLOR_NAMES } from '@brainstrike/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateColor, generateMockFiles, generateStructure } from '../utils';

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
      id: firstUuid,
      startLine: 0,
      endLine: 50,
      isActive: true,
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
