import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostFileReads } from '../../src/workspace-files/file-reads.ts';
import { createWorkspaceRootPins } from '../../src/workspace-files/root-pins.ts';
import { grantedMounts } from './granted-mounts.ts';

const ROOT_ID = '00000000-0000-4000-8000-000000000001';
const NESTED_ID = '00000000-0000-4000-8000-000000000002';
const STALE_ID = '00000000-0000-4000-8000-0000000000ff';

let base: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'host-file-reads-')));
  workspace = path.join(base, 'repo');
  outside = path.join(base, 'outside');
  mkdirSync(path.join(workspace, 'src', 'nested'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(workspace, 'README.md'), '# repo\n');
  writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(workspace, 'src', 'nested', 'deep.ts'), 'export const deep = 2;\n');
  writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n');
});

afterEach(() => {
  rmSync(base, { force: true, recursive: true });
});

interface LiveRoot {
  readonly path: string;
  readonly rootId: string;
}
const opened: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const owner of opened.splice(0).reverse()) {
    await owner.close();
  }
});
/** The reads owner over roots mounted at grant, as the desktop host composes it. */
const reads = async (roots: LiveRoot[]) => {
  const mounts = await grantedMounts(roots);
  const pins = createWorkspaceRootPins({ mounts });
  opened.push(mounts, pins);
  return createHostFileReads({ pins });
};
const failure = (code: string) => ({ failure: expect.objectContaining({ code }) });

/** ADR-0029 stage 4: the Explorer reads only what the host's catalog records as live. */
describe('host file reads', () => {
  it('lists a live root, directories first, naming the root that served it', async () => {
    const { service } = await reads([{ path: workspace, rootId: ROOT_ID }]);

    const listing = await service['workspace/files/list']({ path: workspace });

    expect(listing.rootId).toBe(ROOT_ID);
    expect(listing.truncated).toBe(false);
    expect(
      listing.entries.map((entry) => [entry.name, entry.isDirectory, entry.path]).sort()
    ).toEqual([
      ['README.md', false, path.join(workspace, 'README.md')],
      ['src', true, path.join(workspace, 'src')],
    ]);
  });

  it('reads a file of a live root by its path, and by the root it was listed under', async () => {
    const { service } = await reads([{ path: workspace, rootId: ROOT_ID }]);
    const file = path.join(workspace, 'src', 'index.ts');

    await expect(service['workspace/files/read']({ path: file })).resolves.toEqual({
      content: 'export const value = 1;\n',
    });
    await expect(
      service['workspace/files/read']({ path: 'src/index.ts', rootId: ROOT_ID })
    ).resolves.toEqual({ content: 'export const value = 1;\n' });
    await expect(
      service['workspace/files/read']({ path: file, rootId: ROOT_ID, rootPath: workspace })
    ).resolves.toEqual({ content: 'export const value = 1;\n' });
  });

  it('refuses a folder the catalog does not record as live, even one on disk', async () => {
    const { service } = await reads([{ path: workspace, rootId: ROOT_ID }]);

    await expect(service['workspace/files/list']({ path: outside })).rejects.toMatchObject(
      failure('workspace.path-outside-root')
    );
    await expect(
      service['workspace/files/read']({ path: path.join(outside, 'secret.txt') })
    ).rejects.toMatchObject(failure('workspace.path-outside-root'));
    await expect(
      service['workspace/files/read']({ path: 'secret.txt', rootId: STALE_ID })
    ).rejects.toMatchObject(failure('workspace.root-unmounted'));
    await expect(service['workspace/files/read']({ path: 'src/index.ts' })).rejects.toMatchObject(
      failure('workspace.root-id-invalid')
    );
    await expect(
      service['workspace/files/exists']({ path: path.join(outside, 'secret.txt') })
    ).rejects.toMatchObject(failure('workspace.path-outside-root'));
  });

  it('never follows a symlink out of the root, and names an in-root link', async () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'escape.txt'));
    symlinkSync(path.join(workspace, 'README.md'), path.join(workspace, 'alias.md'));
    const { service } = await reads([{ path: workspace, rootId: ROOT_ID }]);

    await expect(
      service['workspace/files/read']({ path: path.join(workspace, 'escape.txt') })
    ).rejects.toThrow('Path validation failed');
    await expect(
      service['workspace/files/read']({ path: path.join(workspace, 'alias.md') })
    ).rejects.toThrow('File is a symbolic link. Links are not followed inside workspace roots.');
  });

  it('answers a missing or oversized file with the message the Explorer shows', async () => {
    writeFileSync(path.join(workspace, 'big.bin'), Buffer.alloc(800 * 1024, 1));
    const { service } = await reads([{ path: workspace, rootId: ROOT_ID }]);

    await expect(
      service['workspace/files/read']({ path: path.join(workspace, 'gone.ts') })
    ).resolves.toEqual({ code: 'NOT_FOUND', message: expect.stringContaining('ENOENT') });
    await expect(
      service['workspace/files/read']({ path: path.join(workspace, 'big.bin') })
    ).resolves.toEqual({ code: 'TOO_LARGE', message: 'File too large (max: 750KB)' });
    await expect(
      service['workspace/files/exists']({ path: path.join(workspace, 'gone.ts') })
    ).resolves.toEqual({ exists: false });
    await expect(
      service['workspace/files/exists']({ path: path.join(workspace, 'README.md') })
    ).resolves.toEqual({ exists: true });
  });

  it('anchors a read to the root it names; without a live one the deepest root serves it', async () => {
    const nested = path.join(workspace, 'src');
    const { service } = await reads([
      { path: workspace, rootId: ROOT_ID },
      { path: nested, rootId: NESTED_ID },
    ]);
    const deep = path.join(nested, 'nested');

    await expect(
      service['workspace/files/list']({ path: deep, rootId: ROOT_ID })
    ).resolves.toMatchObject({ rootId: ROOT_ID });
    await expect(service['workspace/files/list']({ path: deep })).resolves.toMatchObject({
      rootId: NESTED_ID,
    });
    await expect(
      service['workspace/files/list']({ path: deep, rootId: STALE_ID })
    ).resolves.toMatchObject({ rootId: NESTED_ID });
  });

  it('binds a claimed root by identity and path', async () => {
    const other = path.join(base, 'other');
    mkdirSync(other);
    const { service } = await reads([
      { path: workspace, rootId: ROOT_ID },
      { path: other, rootId: NESTED_ID },
    ]);
    const file = path.join(workspace, 'README.md');

    await expect(
      service['workspace/files/read']({ path: file, rootId: NESTED_ID, rootPath: workspace })
    ).rejects.toMatchObject(failure('workspace.root-mismatch'));
    await expect(
      service['workspace/files/read']({ path: file, rootId: STALE_ID, rootPath: workspace })
    ).rejects.toMatchObject(failure('workspace.root-unmounted'));
    await expect(
      service['workspace/files/read']({ path: file, rootPath: workspace })
    ).rejects.toMatchObject(failure('workspace.root-id-invalid'));
  });

  it('keeps the folder it first opened: a symlink swapped in at its path never grants the outside folder', async () => {
    const { service } = await reads([{ path: workspace, rootId: ROOT_ID }]);
    await expect(service['workspace/files/list']({ path: workspace })).resolves.toMatchObject({
      rootId: ROOT_ID,
    });

    renameSync(workspace, path.join(base, 'moved'));
    symlinkSync(outside, workspace);

    await expect(
      service['workspace/files/read']({ path: 'secret.txt', rootId: ROOT_ID })
    ).rejects.toMatchObject(failure('workspace.path-outside-root'));
    await expect(
      service['workspace/files/read']({ path: path.join(workspace, 'secret.txt') })
    ).rejects.toMatchObject(failure('workspace.path-outside-root'));
    await expect(
      service['workspace/files/list']({ path: workspace, rootId: ROOT_ID })
    ).rejects.toMatchObject(failure('workspace.path-outside-root'));
  });

  it('stops reading once the host closes', async () => {
    const owner = await reads([{ path: workspace, rootId: ROOT_ID }]);
    await owner.close();

    await expect(owner.service['workspace/files/list']({ path: workspace })).rejects.toMatchObject(
      failure('workspace.files-closed')
    );
  });

  it('logs a denied read with a bounded diagnostic that never echoes the requested path', async () => {
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => {
      if (record.scope === 'HostFileReads' && record.level === LogLevel.WARN) {
        records.push(record);
      }
    });
    const rawTail = 'RAW_REALPATH_TAIL_MUST_NOT_APPEAR';
    const requested = path.join(workspace, `renderer-controlled-${'x'.repeat(1024)}${rawTail}`);
    // POSIX refuses this name with ENAMETOOLONG; Windows reports ENOENT. Inject the
    // POSIX failure so the denial is the same on every OS.
    const realpath = fsPromises.realpath.bind(fsPromises);
    const tooLong = vi.spyOn(fsPromises, 'realpath').mockImplementation(async (...args) => {
      const target = String(args[0]);
      if (target.endsWith(rawTail)) {
        throw Object.assign(new Error(`ENAMETOOLONG: name too long, realpath '${target}'`), {
          code: 'ENAMETOOLONG',
        });
      }
      return await realpath(...args);
    });
    try {
      const { service } = await reads([{ path: workspace, rootId: ROOT_ID }]);
      await expect(
        service['workspace/files/read']({ path: requested, rootId: ROOT_ID, rootPath: workspace })
      ).rejects.toThrow();

      expect(records).toHaveLength(1);
      const fields = records[0]?.args[1] as Record<string, unknown>;
      expect(fields).toMatchObject({
        category: 'path-validation',
        code: 'realpath-failure',
        message: 'Workspace read path validation failed.',
        operation: 'readFileByAbsolutePath',
      });
      expect(String(fields['requestedPath']).length).toBeLessThanOrEqual(256);
      expect(JSON.stringify(fields)).not.toContain(rawTail);
    } finally {
      tooLong.mockRestore();
      remove();
    }
  });

  it('joins a read in flight before it finishes closing, and leaves the handle to its owner', async () => {
    const native = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const close = vi.fn();
    const mounts = await grantedMounts(
      [{ path: workspace, rootId: ROOT_ID }],
      async (rootPath) => ({
        canonicalPath: rootPath,
        close,
        listDir: async () => {
          entered.resolve();
          await native.promise;
          return { entries: [], inspected: 0, truncated: false };
        },
        readFile: async () => ({ status: 'not-found' as const }),
      })
    );
    const pins = createWorkspaceRootPins({ mounts });
    const owner = createHostFileReads({ pins });
    const listing = owner.service['workspace/files/list']({ path: workspace });
    await entered.promise;
    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    native.resolve();
    await expect(listing).resolves.toMatchObject({ rootId: ROOT_ID });
    await closing;
    await pins.close();
    expect(close).not.toHaveBeenCalled();
    mounts.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
