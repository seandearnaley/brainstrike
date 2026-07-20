import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import agentDevToolsDefaults from '../../agent-devtools-defaults.json' with { type: 'json' };
import {
  createAgentDevtoolsProfile,
  createMacAgentDebugElectronDist,
  formatMcpConfig,
  parsePort,
  resolveEndpoint,
  rewriteMacAgentDebugInfoPlist,
  waitForEndpoint,
  waitForEndpointOrChildExit,
} from '../start-agent-devtools-session.mjs';

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Electron</string>
  <key>CFBundleExecutable</key>
  <string>Electron</string>
  <key>CFBundleIdentifier</key>
  <string>com.github.Electron</string>
  <key>CFBundleName</key>
  <string>Electron</string>
</dict>
</plist>
`;

test('parsePort accepts a valid explicit port', () => {
  assert.equal(parsePort('9333'), 9333);
});

test('parsePort rejects privileged or invalid ports', () => {
  assert.throws(() => parsePort('80'), /integer from 1024 to 65535/);
  assert.throws(() => parsePort('abc'), /integer from 1024 to 65535/);
});

test('resolveEndpoint returns the local browser url', () => {
  assert.equal(resolveEndpoint(agentDevToolsDefaults.defaultPort), 'http://127.0.0.1:9222');
});

test('formatMcpConfig renders chrome-devtools-mcp browser-url config', () => {
  const rendered = formatMcpConfig('http://127.0.0.1:9222');
  assert.match(rendered, /chrome-devtools-mcp@0\.26\.0/);
  assert.match(rendered, /--browser-url=http:\/\/127\.0\.0\.1:9222/);
  assert.match(rendered, /--no-usage-statistics/);
});

test('creates a lightweight macOS Electron shim with a unique BrainStrike identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-shim-test-'));
  const originalContents = path.join(root, 'original', 'Electron.app', 'Contents');
  const originalExecutable = path.join(originalContents, 'MacOS', 'Electron');
  const userDataDir = path.join(root, 'profile');

  try {
    await mkdir(path.join(originalContents, 'Frameworks'), { recursive: true });
    await mkdir(path.join(originalContents, 'MacOS'), { recursive: true });
    await mkdir(path.join(originalContents, 'Resources'), { recursive: true });
    await writeFile(originalExecutable, '');
    await writeFile(path.join(originalContents, 'Info.plist'), INFO_PLIST);
    await writeFile(path.join(originalContents, 'PkgInfo'), 'APPL????');

    const distPath = await createMacAgentDebugElectronDist({
      electronExecutablePath: originalExecutable,
      userDataDir,
    });
    const shimContents = path.join(distPath, 'Electron.app', 'Contents');

    assert.equal(
      await readlink(path.join(shimContents, 'Frameworks')),
      path.join(originalContents, 'Frameworks')
    );
    assert.equal(
      await readlink(path.join(shimContents, 'Resources')),
      path.join(originalContents, 'Resources')
    );
    assert.equal(await readlink(path.join(shimContents, 'MacOS', 'Electron')), originalExecutable);

    const infoPlist = await readFile(path.join(shimContents, 'Info.plist'), 'utf8');
    assert.match(
      infoPlist,
      /<key>CFBundleDisplayName<\/key>\s*<string>BrainStrike Agent Debug<\/string>/
    );
    assert.match(
      infoPlist,
      /<key>CFBundleIdentifier<\/key>\s*<string>com\.brainstrike\.desktop\.agent-debug<\/string>/
    );
    assert.match(infoPlist, /<key>CFBundleName<\/key>\s*<string>BrainStrike Agent Debug<\/string>/);
    assert.match(infoPlist, /<key>CFBundleExecutable<\/key>\s*<string>Electron<\/string>/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('rejects an Electron plist that cannot provide the required unique identity', () => {
  assert.throws(
    () =>
      rewriteMacAgentDebugInfoPlist(
        '<plist><dict><key>CFBundleDisplayName</key><string>Electron</string></dict></plist>'
      ),
    /exactly one CFBundleIdentifier key/
  );
});

test('removes the temporary profile when macOS identity setup fails closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-agent-debug-profile-test-'));

  try {
    await assert.rejects(
      createAgentDevtoolsProfile({
        electronExecutablePath: path.join(root, 'unexpected-electron'),
        platform: 'darwin',
        tempDirectory: root,
      }),
      /Expected a macOS Electron\.app executable path/
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('waitForEndpoint sleeps between non-ok responses', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: calls >= 2 };
  };
  const startedAt = Date.now();
  try {
    await waitForEndpoint('http://127.0.0.1:9222');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 2);
  assert.ok(Date.now() - startedAt >= 450);
});

test('waitForEndpointOrChildExit rejects when the dev server exits before the endpoint is ready', async () => {
  const originalFetch = globalThis.fetch;
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  globalThis.fetch = async () => ({ ok: false });

  const wait = waitForEndpointOrChildExit('http://127.0.0.1:9222', child);
  child.emit('exit', 1, null);

  try {
    await assert.rejects(wait, /dev server exited with code 1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
