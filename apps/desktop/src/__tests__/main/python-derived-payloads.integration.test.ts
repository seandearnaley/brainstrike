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
  mtime: number;
  pycHeader: string | undefined;
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
      let pycHeader = Buffer.alloc(0);
      const isPyc = entry.path.endsWith('.pyc');
      entry.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        if (isPyc && pycHeader.length < 16) {
          pycHeader = Buffer.concat([pycHeader, chunk.subarray(0, 16 - pycHeader.length)]);
        }
      });
      entry.on('end', () => {
        if (payloads.has(entry.path)) {
          duplicates.push(entry.path);
        }
        payloads.set(entry.path, {
          bytes: entry.size,
          link: entry.linkpath,
          mtime: (entry.mtime?.getTime() ?? 0) / 1000,
          pycHeader: isPyc ? pycHeader.toString('hex') : undefined,
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
          // noMtime intentionally normalizes tar metadata, not payload bytes.
          expect(payload.mtime, name).toBe(1_704_067_200);
          expect(result.get(name), name).toEqual({ ...payload, mtime: 0 });
        }
      }
      const pycs = [...original.entries()].filter(([, payload]) => payload.pycHeader !== undefined);
      expect(pycs.map(([name]) => name).sort()).toEqual([
        'python/lib/python3.13/encodings/__pycache__/__init__.cpython-313.pyc',
        'python/lib/python3.13/encodings/__pycache__/aliases.cpython-313.pyc',
        'python/lib/python3.13/encodings/__pycache__/utf_8.cpython-313.pyc',
      ]);
      for (const [name, payload] of pycs) {
        const header = Buffer.from(payload.pycHeader ?? '', 'hex');
        expect(header.length, name).toBe(16);
        expect(header.subarray(0, 4).toString('hex'), name).toBe('f30d0d0a');
        expect(header.readUInt32LE(4), name).toBe(0); // Timestamp-based, not hash-based.
        const sourceName = name.replace(/\/__pycache__\/([^/]+)\.cpython-313\.pyc$/u, '/$1.py');
        const originalSource = original.get(sourceName);
        const derivedSource = result.get(sourceName);
        expect(originalSource, sourceName).toBeDefined();
        expect(derivedSource, sourceName).toBeDefined();
        expect(header.readUInt32LE(12), name).toBe(originalSource?.bytes);
        expect(header.readUInt32LE(8), name).toBe(1_784_818_192);
        // These three caches are already stale in the pinned upstream. Preserve
        // that evidence: restoring its mtimes would not avoid recompilation.
        expect(header.readUInt32LE(8), name).not.toBe(originalSource?.mtime);
        expect(header.readUInt32LE(8), name).not.toBe(derivedSource?.mtime);
        expect(result.get(name)?.pycHeader, name).toBe(payload.pycHeader);
      }
      expect(
        [...result.keys()].filter((name) => /^libdb[.-]/.test(path.posix.basename(name)))
      ).toEqual([]);
    },
    180_000
  );
});
