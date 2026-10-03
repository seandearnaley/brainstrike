import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/benchmark-workspace-index-pipeline.mjs';

describe('workspace index benchmark script', () => {
  it('parses the documented isolated profile and benchmark modes', () => {
    const options = parseArgs([
      '--profile',
      'isolated',
      '--mode',
      'embedding-ceiling',
      '--mode',
      'db-completion-ceiling',
      '--mode',
      'chunking-ceiling',
      '--mode',
      'import-ceiling',
      '--mode',
      'integrated',
      '--require-device',
      'webgpu',
    ]);

    expect(options.profile).toBe('isolated');
    expect(options.modes).toEqual([
      'embedding-ceiling',
      'db-completion-ceiling',
      'chunking-ceiling',
      'import-ceiling',
      'integrated',
    ]);
    expect(options.requireDevice).toBe('webgpu');
  });

  it('rejects a mode that has no runner instead of ignoring it', () => {
    expect(() => parseArgs(['--mode', 'search-ceiling'])).toThrow(
      /Unknown benchmark mode: search-ceiling/
    );
  });
});
