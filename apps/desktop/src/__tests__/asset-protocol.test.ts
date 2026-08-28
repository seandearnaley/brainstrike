import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { net } from 'electron';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  net: {
    fetch: vi.fn((url: string) => Promise.resolve(new Response(`fetched:${url}`, { status: 200 }))),
  },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

import { createAssetProtocolHandler } from '../asset-protocol';

let root: string;
let outside: string;

beforeAll(async () => {
  // Nest `root` under a base dir so `path.join(root, '..', 'x.png')` resolves to
  // a REAL sibling file OUTSIDE the root — proving containment (403), not mere
  // non-existence, blocks a traversal whose target actually exists.
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-asset-base-')));
  root = path.join(base, 'root');
  await mkdir(root);
  outside = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-asset-outside-')));
  await writeFile(path.join(root, 'img.png'), 'png-bytes');
  await writeFile(path.join(base, 'x.png'), 'sibling');
  await writeFile(path.join(outside, 'secret.png'), 'secret');
  await symlink(path.join(outside, 'secret.png'), path.join(root, 'sneaky.png'));
});

function makeHandler() {
  return createAssetProtocolHandler({
    listRoots: () => Promise.resolve([{ displayName: 'root', path: root, rootId: 'r1' }]),
  });
}

const assetUrl = (p: string): string =>
  `brainstrike-asset://local/asset?path=${encodeURIComponent(p)}`;

beforeEach(() => {
  vi.mocked(net.fetch).mockClear();
});

describe('asset protocol handler', () => {
  it('serves files inside a mounted root', async () => {
    const res = await makeHandler()(new Request(assetUrl(path.join(root, 'img.png'))));
    expect(res.status).toBe(200);
  });

  it('serves files when the mounted root is the filesystem root', async () => {
    const filesystemRoot = path.parse(root).root;
    const handler = createAssetProtocolHandler({
      listRoots: () =>
        Promise.resolve([
          { displayName: 'filesystem root', path: filesystemRoot, rootId: 'r-root' },
        ]),
    });

    const res = await handler(new Request(assetUrl(path.join(root, 'img.png'))));
    expect(res.status).toBe(200);
    expect(net.fetch).toHaveBeenCalledOnce();
  });

  it('rejects a sibling directory that merely shares the root path prefix', async () => {
    const sibling = `${root}-evil`;
    await mkdir(sibling);
    await writeFile(path.join(sibling, 'img.png'), 'png-bytes');

    const res = await makeHandler()(new Request(assetUrl(path.join(sibling, 'img.png'))));
    expect(res.status).toBe(404);
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('rejects files outside every root with 404 (not 403 — no existence oracle)', async () => {
    const res = await makeHandler()(new Request(assetUrl(path.join(outside, 'secret.png'))));
    expect(res.status).toBe(404);
  });

  it('rejects symlink escapes (realpath containment) with 404', async () => {
    const res = await makeHandler()(new Request(assetUrl(path.join(root, 'sneaky.png'))));
    expect(res.status).toBe(404);
  });

  it('rejects traversal in the requested path with 404', async () => {
    const res = await makeHandler()(new Request(assetUrl(path.join(root, '..', 'x.png'))));
    expect(res.status).toBe(404);
  });

  it('400s a missing path parameter', async () => {
    const res = await makeHandler()(new Request('brainstrike-asset://local/asset'));
    expect(res.status).toBe(400);
  });

  it('400s a relative (non-absolute) path parameter', async () => {
    const res = await makeHandler()(new Request(assetUrl('relative/img.png')));
    expect(res.status).toBe(400);
  });

  it('404s a nonexistent file inside the root', async () => {
    const res = await makeHandler()(new Request(assetUrl(path.join(root, 'nope.png'))));
    expect(res.status).toBe(404);
  });

  it('makes outside-root and nonexistent-file responses indistinguishable (closes the existence oracle)', async () => {
    const outsideRes = await makeHandler()(new Request(assetUrl(path.join(outside, 'secret.png'))));
    const missingRes = await makeHandler()(new Request(assetUrl(path.join(root, 'nope.png'))));

    expect(outsideRes.status).toBe(missingRes.status);
    expect(await outsideRes.text()).toBe(await missingRes.text());
  });
});
