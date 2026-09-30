import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { create, extract, list } from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  derivePythonRuntimeArchive,
  LINUX_DBM_MODULE_PATH,
} from '../../../scripts/derive-python-runtime.mjs';
import { fetchPythonRuntime } from '../../../scripts/fetch-python-runtime.mjs';

const TARGET = 'x86_64-unknown-linux-gnu';
const SOURCE_NAME = `cpython-3.13.14+20260728-${TARGET}-install_only.tar.gz`;
const DERIVED_NAME = `cpython-3.13.14+20260728-${TARGET}-brainstrike-no-dbm-v1.tar.gz`;
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function fixture(
  includeDbm = true,
  extraDb = false
): Promise<{ root: string; source: string; output: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-python-derived-'));
  cleanup.push(root);
  const tree = path.join(root, 'tree');
  const binary = path.join(tree, 'python/bin/python3.13');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, 'interpreter payload', { mode: 0o755 });
  await fs.symlink('python3.13', path.join(tree, 'python/bin/python3'));
  await fs.mkdir(path.dirname(path.join(tree, LINUX_DBM_MODULE_PATH)), { recursive: true });
  if (includeDbm) {
    await fs.writeFile(path.join(tree, LINUX_DBM_MODULE_PATH), 'Berkeley DB fixture');
  }
  if (extraDb) {
    await fs.writeFile(path.join(tree, 'python/lib/libdb.so'), 'unexpected Berkeley DB');
  }
  const source = path.join(root, SOURCE_NAME);
  await create({ cwd: tree, file: source, gzip: true, noMtime: true, portable: true }, ['python']);
  return { output: path.join(root, DERIVED_NAME), root, source };
}

async function integrity(file: string): Promise<{ bytes: number; sha256: string }> {
  const content = await fs.readFile(file);
  return { bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}

async function writeDerivedManifest(
  root: string,
  source: string,
  output: string,
  badHash = false
): Promise<void> {
  const derived = await integrity(output);
  await fs.writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      assetUrlTemplate:
        'https://example.invalid/{releaseTag}/cpython-{pythonVersion}+{releaseTag}-{target}-{variant}.tar.gz',
      pythonVersion: '3.13.14',
      releaseTag: '20260728',
      supportedTargets: [TARGET],
      targets: {
        [TARGET]: {
          ...(await integrity(source)),
          derived: {
            ...derived,
            archiveFileName: DERIVED_NAME,
            sha256: badHash ? 'a'.repeat(64) : derived.sha256,
            variant: 'no-dbm-v1',
          },
        },
      },
      variant: 'install_only',
    })
  );
}

describe.skipIf(process.platform === 'win32')(
  'Linux Python no-dbm-v1 derivation (requires POSIX symlinks)',
  () => {
    it('removes only the DB-linked module and deterministically preserves executable payloads and symlinks', async () => {
      const { root, source, output } = await fixture();
      await derivePythonRuntimeArchive(source, output);
      const second = `${output}.second`;
      await derivePythonRuntimeArchive(source, second);
      expect(await integrity(second)).toEqual(await integrity(output));
      const entries: string[] = [];
      await list({
        file: output,
        onReadEntry: (entry) => {
          entries.push(entry.path);
        },
      });
      expect(entries).not.toContain(LINUX_DBM_MODULE_PATH);
      expect(entries).toContain('python/bin/python3');
      const unpacked = path.join(root, 'unpacked');
      await fs.mkdir(unpacked);
      await extract({ cwd: unpacked, file: output });
      expect(await fs.readFile(path.join(unpacked, 'python/bin/python3'), 'utf8')).toBe(
        'interpreter payload'
      );
      expect(await fs.readlink(path.join(unpacked, 'python/bin/python3'))).toBe('python3.13');
      expect((await fs.stat(path.join(unpacked, 'python/bin/python3'))).mode & 0o111).not.toBe(0);
    });

    it('never overwrites the pinned upstream source', async () => {
      const { source } = await fixture();
      const original = await integrity(source);
      await expect(derivePythonRuntimeArchive(source, source)).rejects.toThrow(
        'must not overwrite'
      );
      expect(await integrity(source)).toEqual(original);
    });

    it.each([
      { extraDb: false, includeDbm: false },
      { extraDb: true, includeDbm: true },
    ])('fails closed on unexpected DB contents: %j', async ({ includeDbm, extraDb }) => {
      const { source, output } = await fixture(includeDbm, extraDb);
      await expect(derivePythonRuntimeArchive(source, output)).rejects.toThrow(
        'expected exactly one'
      );
      await expect(fs.access(output)).rejects.toThrow();
    });

    it('verifies the upstream and derived pins and reuses both offline', async () => {
      const { root, source, output } = await fixture();
      await derivePythonRuntimeArchive(source, output);
      const expected = await integrity(output);
      await writeDerivedManifest(root, source, output);
      await fs.rm(output);
      const fetchImpl = vi.fn(() => {
        throw new Error('offline');
      });
      await fetchPythonRuntime({ fetchImpl, log: () => undefined, resourcesDir: root });
      expect(await integrity(output)).toEqual(expected);
      await fetchPythonRuntime({ fetchImpl, log: () => undefined, resourcesDir: root });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a derived checksum mismatch and removes the incomplete result', async () => {
      const { root, source, output } = await fixture();
      await derivePythonRuntimeArchive(source, output);
      await writeDerivedManifest(root, source, output, true);
      await fs.rm(output);
      await expect(
        fetchPythonRuntime({ fetchImpl: vi.fn(), log: () => undefined, resourcesDir: root })
      ).rejects.toThrow('sha256 mismatch');
      await expect(fs.access(output)).rejects.toThrow();
      expect((await fs.readdir(root)).some((name) => name.includes('.derive-'))).toBe(false);
    });
  }
);
