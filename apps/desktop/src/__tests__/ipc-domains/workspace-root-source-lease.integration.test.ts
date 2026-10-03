import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeSecureRoot } from '../../ipc-domains/workspace-root-seams';
import { createRegistry, rootHandle } from './workspace-root-registry-test-helpers';

describe('Canonical source borrows over actual native mounted handles', () => {
  let fixture: string | undefined;
  let registry: ReturnType<typeof createRegistry> | undefined;

  afterEach(async () => {
    await registry?.dispose();
    if (fixture) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  async function prepare(): Promise<{ lease: CanonicalWorkspaceLease; workspace: string }> {
    fixture = await mkdtemp(path.join(tmpdir(), 'brainstrike-canonical-lease-'));
    const workspace = path.join(fixture, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'inside.txt'), 'original native bytes');
    await writeFile(path.join(workspace, 'other.txt'), 'other');
    const createSecureRoot = vi.fn(createNativeSecureRoot);
    registry = createRegistry({ createSecureRoot });
    const descriptor = await registry.addRoot(rootHandle(workspace));
    const lease = await registry.borrowSourceRoot(descriptor.rootId, async () => ({
      close: async () => undefined,
    }));
    expect(createSecureRoot).toHaveBeenCalledTimes(1);
    return { lease, workspace };
  }

  it('preserves actual bytes, native byte limits and honest listing truncation', async () => {
    const { lease, workspace } = await prepare();
    const context = { requestId: 'native-lease-read', signal: new AbortController().signal };
    const result = await lease.readFile('inside.txt', 100, context);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('Expected actual native source bytes.');
    }
    expect(Buffer.from(result.content).toString('utf8')).toBe('original native bytes');
    await expect(lease.readFile('inside.txt', 3, context)).resolves.toEqual({
      status: 'oversized',
    });
    const listing = await lease.listDir('.', 1, context);
    expect(listing?.truncated).toBe(true);
    expect(listing?.entries).toHaveLength(1);
    await lease.retire();
    await expect(registry?.readFile(path.join(workspace, 'inside.txt'))).resolves.toBe(
      'original native bytes'
    );
  });

  it('cannot read a symlink target or authorize a path-swapped replacement tree', async () => {
    const { lease, workspace } = await prepare();
    if (!fixture) {
      throw new Error('Native fixture was not created.');
    }
    const outside = path.join(fixture, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'inside.txt'), 'outside authority');
    await symlink('inside.txt', path.join(workspace, 'inside-link.txt'));
    const context = { requestId: 'native-lease-authority', signal: new AbortController().signal };
    await expect(lease.readFile('inside-link.txt', 100, context)).resolves.toEqual({
      status: 'unreadable',
    });
    await rename(workspace, path.join(fixture, 'parked-workspace'));
    await symlink(outside, workspace, 'dir');
    await expect(lease.readFile('inside.txt', 100, context)).rejects.toThrow();
    await lease.retire();
  });
});
