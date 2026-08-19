import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeGitBlobId,
  parseMeasurementVariant,
  verifyHistoricalSourceBinding,
} from '../bench/bst-372-source-binding.mjs';

const tempRoots: string[] = [];
type SourceBindings = NonNullable<Parameters<typeof verifyHistoricalSourceBinding>[0]['bindings']>;

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

  it('parses only the two source-bound measurement variants', () => {
    expect(parseMeasurementVariant('pre-stream')).toBe('pre-stream');
    expect(parseMeasurementVariant('stream')).toBe('stream');
    expect(() => parseMeasurementVariant('caller-supplied-label')).toThrow(
      'BST372_VARIANT must be pre-stream or stream.'
    );
  });

  it('returns frozen metadata derived from verified source blobs', () => {
    const worker = 'const implementation = "verified";\n';
    const shared = 'export const protocol = "verified";\n';
    const packageRoot = createPackageRoot();
    writeSources(packageRoot, worker, shared);
    const sourceBlobs = {
      'src/embedding.worker.ts': computeGitBlobId(Buffer.from(worker)),
      'src/shared.ts': computeGitBlobId(Buffer.from(shared)),
    };
    const bindings = {
      'pre-stream': { commit: 'pre-stream-commit', sourceBlobs },
      stream: { commit: 'stream-commit', sourceBlobs },
    } satisfies SourceBindings;

    const verified = verifyHistoricalSourceBinding({
      bindings,
      packageRoot,
      variant: 'stream',
    });

    expect(verified).toEqual({
      commit: 'stream-commit',
      sourceBlobs,
      variant: 'stream',
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.sourceBlobs)).toBe(true);
  });

  it('rejects missing and empty source-binding definitions', () => {
    const validBinding = {
      commit: 'stream-commit',
      sourceBlobs: { 'src/embedding.worker.ts': 'unused' },
    };
    const missingPreStreamBinding = {
      stream: validBinding,
    } as unknown as SourceBindings;
    const emptyPreStreamBinding = {
      'pre-stream': { commit: 'pre-stream-commit', sourceBlobs: {} },
      stream: validBinding,
    } satisfies SourceBindings;

    expect(() =>
      verifyHistoricalSourceBinding({
        bindings: missingPreStreamBinding,
        packageRoot: createPackageRoot(),
        variant: 'pre-stream',
      })
    ).toThrow('No BST-372 historical source binding exists for pre-stream.');
    expect(() =>
      verifyHistoricalSourceBinding({
        bindings: emptyPreStreamBinding,
        packageRoot: createPackageRoot(),
        variant: 'pre-stream',
      })
    ).toThrow('BST-372 historical source binding for pre-stream has no source blobs.');
  });
});
