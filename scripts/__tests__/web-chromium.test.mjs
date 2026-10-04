import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getWebChromiumExecutablePath,
  getWebChromiumTarget,
  WEB_CHROMIUM_VERSION,
} from '../../apps/web/config/web-chromium.mjs';
import { provisionWebChromium } from '../provision-web-chromium.mjs';

test('selects the exact CfT platform and executable for supported hosts', () => {
  for (const [platform, arch, artifact] of [
    ['darwin', 'arm64', 'mac-arm64'],
    ['darwin', 'x64', 'mac-x64'],
    ['linux', 'arm64', 'linux-arm64'],
    ['linux', 'x64', 'linux64'],
  ]) {
    const target = getWebChromiumTarget(platform, arch);
    assert.equal(target.platform, artifact);
    assert.equal(
      target.url,
      `https://storage.googleapis.com/chrome-for-testing-public/${WEB_CHROMIUM_VERSION}/${artifact}/chrome-${artifact}.zip`
    );
    assert.equal(
      getWebChromiumExecutablePath('/explicit/browser', platform, arch),
      `/explicit/browser/${WEB_CHROMIUM_VERSION}/${artifact}/${target.executable}`
    );
  }
});

test('rejects an absent or relative provisioned browser root', () => {
  assert.throws(
    () => getWebChromiumExecutablePath(undefined, 'linux', 'x64'),
    /BRAINSTRIKE_WEB_CHROMIUM_DIR.*absolute/
  );
  assert.throws(() => getWebChromiumExecutablePath('relative', 'linux', 'x64'), /absolute/);
});

test('rejects unsupported hosts instead of selecting another browser', () => {
  assert.throws(() => getWebChromiumTarget('linux', 'riscv64'), /Unsupported.*linux.*riscv64/);
  assert.throws(() => getWebChromiumTarget('win32', 'x64'), /Unsupported.*win32.*x64/);
});

test('provisioning refuses an existing installation before any download', async (t) => {
  const download = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected download');
  });
  const root = await mkdtemp(join(tmpdir(), 'web-chromium-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const target = getWebChromiumTarget(process.platform, process.arch);
  await mkdir(join(root, WEB_CHROMIUM_VERSION, target.platform), { recursive: true });
  await assert.rejects(provisionWebChromium(root), { code: 'EEXIST' });
  assert.equal(download.mock.callCount(), 0);
});

test('a rejected download leaves no exposed executable and keeps failure evidence', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  const root = await mkdtemp(join(tmpdir(), 'web-chromium-failure-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await assert.rejects(provisionWebChromium(root), /HTTP 503/);
  const target = getWebChromiumTarget(process.platform, process.arch);
  const versionDirectory = join(root, WEB_CHROMIUM_VERSION);
  assert.deepEqual(await readdir(join(versionDirectory, target.platform)), []);
  assert.equal(
    (await readdir(versionDirectory)).filter((name) => name.startsWith('.download-')).length,
    1
  );
});
