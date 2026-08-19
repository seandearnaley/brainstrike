import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeGitBlobId,
  verifyHistoricalSourceBinding,
} from '../bench/bst-372-source-binding.mjs';

const tempRoots: string[] = [];

function createPackageRoot(): string {
  const packageRoot = mkdtempSync(join(tmpdir(), 'bst372-source-binding-'));
  tempRoots.push(packageRoot);
  mkdirSync(join(packageRoot, 'src'));
  return packageRoot;
}

function writeSources(packageRoot: string, worker: string, shared: string): void {
  writeFileSync(join(packageRoot, 'src/embedding.worker.ts'), worker);
  writeFileSync(join(packageRoot, 'src/shared.ts'), shared);
}

describe('BST-372 historical source binding', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('rejects the streaming tree when it is mislabeled as the pre-stream revision', () => {
    const preStreamWorker = 'const implementation = "pre-stream";\n';
    const preStreamShared = 'export const protocol = "pre-stream";\n';
    const streamWorker = 'const implementation = "stream";\n';
    const streamShared = 'export const protocol = "stream";\n';
    const packageRoot = createPackageRoot();
    writeSources(packageRoot, streamWorker, streamShared);

    const bindings = {
      'pre-stream': {
        commit: 'pre-stream-commit',
        sourceBlobs: {
          'src/embedding.worker.ts': computeGitBlobId(Buffer.from(preStreamWorker)),
          'src/shared.ts': computeGitBlobId(Buffer.from(preStreamShared)),
        },
      },
      stream: {
        commit: 'stream-commit',
        sourceBlobs: {
          'src/embedding.worker.ts': computeGitBlobId(Buffer.from(streamWorker)),
          'src/shared.ts': computeGitBlobId(Buffer.from(streamShared)),
        },
      },
    } as const;

    expect(() =>
      verifyHistoricalSourceBinding({
        bindings,
        packageRoot,
        variant: 'pre-stream',
      })
    ).toThrow(/source mismatch.*embedding\.worker\.ts.*Refusing to measure/i);
  });
});
