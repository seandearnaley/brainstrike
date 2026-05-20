import { describe, expect, it } from 'vitest';
import { isCompilerHotspot } from '../compiler-hotspots';

describe('build-utils/compiler-hotspots', () => {
  it('matches unix paths', () => {
    expect(isCompilerHotspot('/repo/packages/hooks/src/x.ts')).toBe(true);
    expect(isCompilerHotspot('/repo/packages/file-explorer-ui/src/workspace-settings.tsx')).toBe(
      true
    );
    expect(isCompilerHotspot('/repo/packages/file-explorer-ui/src/view.tsx')).toBe(true);
    expect(isCompilerHotspot('/repo/packages/types/src/index.ts')).toBe(false);
  });

  it('matches windows paths', () => {
    expect(isCompilerHotspot('C:\\repo\\packages\\hooks\\src\\x.tsx')).toBe(true);
    expect(
      isCompilerHotspot('C:\\repo\\packages\\file-explorer-ui\\src\\workspace-settings.tsx')
    ).toBe(true);
    expect(isCompilerHotspot('C:\\repo\\packages\\file-explorer-hooks\\src\\a.ts')).toBe(true);
    expect(isCompilerHotspot('C:\\repo\\packages\\utils\\src\\index.ts')).toBe(false);
  });
});
