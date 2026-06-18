import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertRunnableBenchmarkModes,
  findLatestWorkspaceIndexEvidencePath,
  parseArgs,
} from '../../scripts/benchmark-workspace-index-pipeline.mjs';

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

  it('allows the DB completion stage benchmark mode implemented by the Electron harness', () => {
    const options = parseArgs(['--mode', 'db-completion-ceiling']);

    expect(() => assertRunnableBenchmarkModes(options)).not.toThrow();
  });

  it('fails loudly instead of silently ignoring unimplemented stage benchmark modes', () => {
    const options = parseArgs(['--mode', 'embedding-ceiling']);

    expect(() => assertRunnableBenchmarkModes(options)).toThrow(
      'requires the Electron stage benchmark harness'
    );
  });

  it('finds the newest full-run evidence in Playwright blob-report output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-benchmark-script-'));
    const staleDir = path.join(root, 'test-results', 'old-run');
    const currentDir = path.join(root, 'blob-report', 'new-run');
    await mkdir(staleDir, { recursive: true });
    await mkdir(currentDir, { recursive: true });
    const staleEvidence = path.join(staleDir, 'full-workspace-index-evidence.json');
    const currentEvidence = path.join(currentDir, 'full-workspace-index-evidence.json');
    await writeFile(staleEvidence, '{}', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(currentEvidence, '{}', 'utf8');

    await expect(
      findLatestWorkspaceIndexEvidencePath({
        searchRoots: [path.join(root, 'test-results'), path.join(root, 'blob-report')],
      })
    ).resolves.toBe(currentEvidence);
  });
});
