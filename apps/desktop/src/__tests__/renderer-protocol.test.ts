import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { net } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRendererProtocolHandler } from '../renderer-protocol';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, protocol: { handle: vi.fn() } }));
let directory: string;
let handler: ReturnType<typeof createRendererProtocolHandler>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'bst1999-assets-'));
  await mkdir(path.join(directory, 'bundle'));
  await writeFile(
    path.join(directory, 'bundle', 'worker.js'),
    'postMessage({coi:crossOriginIsolated});'
  );
  await writeFile(path.join(directory, 'outside.js'), 'private');
  await symlink(path.join(directory, 'outside.js'), path.join(directory, 'bundle', 'escape.js'));
  handler = createRendererProtocolHandler(path.join(directory, 'bundle', 'index.html'));
  vi.mocked(net.fetch).mockReset();
  vi.mocked(net.fetch).mockImplementation(
    async () =>
      new Response('postMessage({coi:crossOriginIsolated});', {
        headers: { 'content-type': 'text/javascript' },
      })
  );
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});
it('serves confined assets with the embedder policy workers need and preserved MIME', async () => {
  const response = await handler(new Request('brainstrike-app://bundle/worker.js'));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/javascript');
  expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
  expect(response.headers.get('cross-origin-opener-policy')).toBeNull();
  expect(await response.text()).toBe('postMessage({coi:crossOriginIsolated});');
  expect(net.fetch).toHaveBeenCalledTimes(1);
});
it.each([
  ['embedding-host', 'same-origin', 'require-corp'],
  ['chunking-host', null, null],
  [null, null, null],
])('isolates the document only for an inference host (mode %s)', async (mode, opener, embedder) => {
  vi.mocked(net.fetch).mockImplementation(
    async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
  );
  await writeFile(path.join(directory, 'bundle', 'index.html'), '<!doctype html>');
  const query = mode === null ? '' : `?mode=${mode}&runtimeId=host-1`;
  const response = await handler(new Request(`brainstrike-app://bundle/index.html${query}`));
  expect(response.headers.get('cross-origin-opener-policy')).toBe(opener);
  expect(response.headers.get('cross-origin-embedder-policy')).toBe(embedder);
});
it('serves HEAD without a body', async () => {
  const response = await handler(
    new Request('brainstrike-app://bundle/worker.js', { method: 'HEAD' })
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('');
});
it.each([
  'brainstrike-app://foreign/worker.js',
  'brainstrike-app://bundle:4000/worker.js',
  'brainstrike-app://bundle/missing.js',
  'brainstrike-app://bundle/escape.js',
  'brainstrike-app://bundle/%2e%2e%2foutside.js',
  'brainstrike-app://bundle/%5coutside.js',
  'brainstrike-app://bundle/%00',
  'brainstrike-app://bundle/%ZZ',
])('refuses resource outside the bundled authority: %s', async (url) => {
  expect((await handler(new Request(url))).status).toBe(404);
  expect(net.fetch).not.toHaveBeenCalled();
});
it('refuses mutation methods', async () => {
  expect(
    (await handler(new Request('brainstrike-app://bundle/worker.js', { method: 'POST' }))).status
  ).toBe(405);
  expect(net.fetch).not.toHaveBeenCalled();
});
it('preserves an independent resource read failure', async () => {
  const cause = new Error('recorded resource failure');
  vi.mocked(net.fetch).mockRejectedValue(cause);
  await expect(handler(new Request('brainstrike-app://bundle/worker.js'))).rejects.toBe(cause);
});
