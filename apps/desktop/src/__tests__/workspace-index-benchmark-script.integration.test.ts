import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/benchmark-workspace-index-pipeline.mjs';

describe('workspace index benchmark script', () => {
  it('parses the documented isolated profile and the integrated benchmark', () => {
    const options = parseArgs([
      '--profile',
      'isolated',
      '--mode',
      'integrated',
      '--require-device',
      'webgpu',
    ]);

    expect(options.profile).toBe('isolated');
    expect(options.requireDevice).toBe('webgpu');
  });

  it.each(['embedding-ceiling', 'db-completion-ceiling', 'chunking-ceiling', 'import-ceiling'])(
    'refuses the retired PGlite stage mode %s (BST-2012)',
    (mode) => {
      expect(() => parseArgs(['--mode', mode])).toThrow(/Expected: integrated/);
    }
  );

  it('rejects a mode that has no runner instead of ignoring it', () => {
    expect(() => parseArgs(['--mode', 'search-ceiling'])).toThrow(
      /Unknown benchmark mode: search-ceiling/
    );
  });
});
