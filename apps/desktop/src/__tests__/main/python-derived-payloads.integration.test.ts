import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { list } from 'tar';
import { describe, expect, it } from 'vitest';
import { LINUX_DBM_MODULE_PATH } from '../../../scripts/derive-python-runtime.mjs';
import {
  type PythonRuntimeManifest,
  renderPythonRuntimeAssetFileName,
} from '../../python-runtime/resolve-python-binary';

const resourcesDir = path.resolve(import.meta.dirname, '../../../resources/python-runtime');
const manifest = JSON.parse(
  readFileSync(path.join(resourcesDir, 'manifest.json'), 'utf8')
) as PythonRuntimeManifest;
const target = 'x86_64-unknown-linux-gnu';
const source = path.join(resourcesDir, renderPythonRuntimeAssetFileName(manifest, target));
const derivedName = manifest.targets[target]?.derived?.archiveFileName;
const derived = derivedName ? path.join(resourcesDir, derivedName) : undefined;
const skipReason =
  existsSync(source) && derived && existsSync(derived)
    ? undefined
    : 'pinned upstream and derived Linux archives required; run fetch:python-runtime first';

interface Payload {
  bytes: number;
  link: string | undefined;
  sha256: string;
  type: string;
}
async function archivePayloads(file: string): Promise<Map<string, Payload>> {
  const payloads = new Map<string, Payload>();
  const duplicates: string[] = [];
  await list({
    file,
    onReadEntry: (entry) => {
      const hash = createHash('sha256');
      entry.on('data', (chunk: Buffer) => {
        hash.update(chunk);
      });
      entry.on('end', () => {
        if (payloads.has(entry.path)) {
          duplicates.push(entry.path);
        }
        payloads.set(entry.path, {
          bytes: entry.size,
          link: entry.linkpath,
          sha256: hash.digest('hex'),
          type: entry.type,
        });
      });
    },
    strict: true,
  });
  if (duplicates.length > 0) {
    throw new Error(`Duplicate archive entries: ${duplicates.join(', ')}`);
  }
  return payloads;
}

describe('derived Linux Python payload audit', () => {
  it.skipIf(skipReason !== undefined)(
    `removes exactly the Berkeley DB-linked module and preserves every other payload${skipReason ? ` [SKIPPED: ${skipReason}]` : ''}`,
    async () => {
      if (!derived) {
        throw new Error('derived archive pin missing');
      }
      const original = await archivePayloads(source);
      const result = await archivePayloads(derived);
      expect(original.has(LINUX_DBM_MODULE_PATH)).toBe(true);
      expect(result.has(LINUX_DBM_MODULE_PATH)).toBe(false);
      expect(result.size).toBe(original.size - 1);
      for (const [name, payload] of original) {
        if (name !== LINUX_DBM_MODULE_PATH) {
          expect(result.get(name), name).toEqual(payload);
        }
      }
      expect(
        [...result.keys()].filter((name) => /^libdb[.-]/.test(path.posix.basename(name)))
      ).toEqual([]);
    },
    180_000
  );
});
