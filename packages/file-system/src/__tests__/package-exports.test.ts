import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('@brainstrike/file-system package contract', () => {
  it('publishes the supported Parcel producer testing boundary', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };

    expect(manifest.exports['./testing/parcel-producer']).toEqual({
      default: './dist/testing/parcel-producer.js',
      types: './dist/testing/parcel-producer.d.ts',
    });
    expect(existsSync(join(packageRoot, 'src/testing/parcel-producer.ts'))).toBe(true);
  });
});
