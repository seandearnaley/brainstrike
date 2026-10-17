import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execFileAsync = promisify(execFile);
const rootRequire = createRequire(path.join(root, 'package.json'));

function nycConfigRequire() {
  const nyc = createRequire(rootRequire.resolve('nyc'));
  return createRequire(nyc.resolve('@istanbuljs/load-nyc-config'));
}

function electronGetRequire() {
  const desktop = createRequire(path.join(root, 'apps/desktop/package.json'));
  const electronBuilder = createRequire(desktop.resolve('electron-builder'));
  const builder = createRequire(electronBuilder.resolve('app-builder-lib'));
  return createRequire(builder.resolve('@electron/get'));
}

function assertRetired(lock) {
  assert.ok(Object.keys(lock.packages).length, 'expected an installed dependency graph');
  assert.ok(
    !Object.keys(lock.packages).some((id) => id.startsWith('sprintf-js@')),
    'sprintf-js remains'
  );
  for (const [owner, field, dependency, supported] of [
    ['js-yaml@3.', 'dependencies', 'argparse', /^3\./],
    ['@electron/get@3.', 'optionalDependencies', 'global-agent', /^4\./],
  ]) {
    const owners = Object.entries(lock.snapshots).filter(([id]) => id.startsWith(owner));
    assert.ok(owners.length, `missing ${owner} owner`);
    for (const [id, snapshot] of owners) {
      assert.match(snapshot[field]?.[dependency] ?? '', supported, `${id}: qualify ${dependency}`);
    }
  }
}

test('all sprintf-js copies are retired through qualified owners, with negative controls', async () => {
  const clean = {
    packages: { 'argparse@3.0.3': {}, 'global-agent@4.1.3': {} },
    snapshots: {
      '@electron/get@3.1.0': { optionalDependencies: { 'global-agent': '4.1.3' } },
      'js-yaml@3.15.2': { dependencies: { argparse: '3.0.3' } },
    },
  };
  assertRetired(clean);
  for (const version of ['1.0.3', '1.1.3']) {
    assert.throws(
      () =>
        assertRetired({ ...clean, packages: { ...clean.packages, [`sprintf-js@${version}`]: {} } }),
      /sprintf-js remains/
    );
  }
  for (const snapshots of [
    {},
    { ...clean.snapshots, 'js-yaml@3.15.2': { dependencies: { argparse: '1.0.10' } } },
    {
      ...clean.snapshots,
      '@electron/get@3.1.0': { optionalDependencies: { 'global-agent': '3.0.0' } },
    },
  ]) {
    assert.throws(() => assertRetired({ ...clean, snapshots }));
  }
  assert.throws(() => assertRetired({ packages: {}, snapshots: {} }), /expected/);
  assertRetired(parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
});

test('legacy js-yaml CLI preserves help, version, conversion and visible failures', () => {
  const yamlRequire = createRequire(nycConfigRequire().resolve('js-yaml'));
  const manifest = yamlRequire('./package.json');
  const cli = path.join(
    path.dirname(yamlRequire.resolve('./package.json')),
    manifest.bin['js-yaml']
  );
  const run = (args, input) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      input,
      timeout: 5000,
    });
    assert.ifError(result.error);
    return result;
  };
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--compact/);
  assert.match(help.stdout, /--trace/);
  const version = run(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), manifest.version);
  const parsed = run(['--compact', '--to-json', '-'], 'enabled: true\nports: [3000, 3001]\n');
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(parsed.stdout), { enabled: true, ports: [3000, 3001] });
  const dumped = run(['-'], '{"name":"fixture","enabled":true}');
  assert.equal(dumped.status, 0, dumped.stderr);
  assert.deepEqual(yamlRequire('.').safeLoad(dumped.stdout), { enabled: true, name: 'fixture' });
  const invalid = run(['--compact', '-'], 'broken: [unterminated');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /YAMLException/);
  const option = run(['--not-a-real-option']);
  assert.equal(option.status, 2);
  assert.match(option.stderr, /unrecognized arguments/i);
});

test('the YAML CLI parser does not execute unbounded precision in help templates', () => {
  const yaml = createRequire(nycConfigRequire().resolve('js-yaml'));
  const result = spawnSync(
    process.execPath,
    [
      '--eval',
      `
    const assert = require('node:assert/strict');
    const { ArgumentParser } = require(${JSON.stringify(yaml.resolve('argparse'))});
    const parser = new ArgumentParser({ prog: '1.23', usage: '%(prog).1000000f' });
    parser.exit = () => { throw new Error('expected-visible-cli-error'); };
    assert.throws(() => parser.error('fixture error'), /expected-visible-cli-error/);
  `,
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('nyc YAML config and Mastra frontmatter retain their existing parser contracts', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sprintf-yaml-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  await writeFile(path.join(dir, 'package.json'), '{}');
  await writeFile(path.join(dir, '.nycrc.yaml'), 'include: src/**/*.ts\nreporter: [json, lcov]\n');
  const config = await nycConfigRequire()('@istanbuljs/load-nyc-config').loadNycConfig({
    cwd: dir,
    nycrcPath: '.nycrc.yaml',
  });
  assert.deepEqual(config.include, ['src/**/*.ts']);
  assert.deepEqual(config.reporter, ['json', 'lcov']);
  const agent = createRequire(path.join(root, 'packages/agent/package.json'));
  const mastra = createRequire(agent.resolve('@mastra/core'));
  const matter = mastra('gray-matter');
  const parsed = matter('---\nname: fixture\nenabled: true\n---\nBody');
  assert.deepEqual(parsed.data, { enabled: true, name: 'fixture' });
  assert.equal(parsed.content.trim(), 'Body');
  assert.deepEqual(matter(matter.stringify('Body', parsed.data)).data, parsed.data);
  assert.throws(() => matter('---\nbroken: [unterminated\n---\nBody'), /unexpected end/);
});

function cleanEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/proxy|^ELECTRON_|^GLOBAL_AGENT_|^ROARR_|^DEBUG$|^NODE_(OPTIONS|EXTRA_CA_CERTS|TLS_REJECT_UNAUTHORIZED)/i.test(
          name
        )
    )
  );
}

async function listen(server, t, secure = false) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `${secure ? 'https://localhost' : 'http://127.0.0.1'}:${server.address().port}`;
}

function fixtureCertificate() {
  // Mint a disposable fixture with an existing vendor primitive. Verification
  // is always Node TLS, never Forge's affected RSA verification implementation.
  const agent = createRequire(path.join(root, 'packages/agent/package.json'));
  const sandbox = createRequire(agent.resolve('@anthropic-ai/sandbox-runtime'));
  const forge = sandbox('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [{ name: 'commonName', value: 'Disposable loopback fixture' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { cA: true, name: 'basicConstraints' },
    { altNames: [{ type: 2, value: 'localhost' }], name: 'subjectAltName' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

for (const mode of ['http-proxy', 'no-proxy', 'https-proxy', 'untrusted-tls', 'bad-checksum']) {
  test(`Electron's actual downloader preserves ${mode}`, { timeout: 15_000 }, async (t) => {
    const getRequire = electronGetRequire();
    const entry = getRequire.resolve('./index.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sprintf-electron-'));
    t.after(() => rm(dir, { force: true, recursive: true }));
    const secure = ['https-proxy', 'untrusted-tls'].includes(mode);
    const certificate = secure ? fixtureCertificate() : undefined;
    let downloads = 0;
    const handler = (_req, res) => {
      downloads++;
      res.end('loopback artifact');
    };
    const origin = await listen(
      secure ? https.createServer(certificate, handler) : http.createServer(handler),
      t,
      secure
    );
    let proxied = 0;
    const proxy = http.createServer((req, res) => {
      proxied++;
      assert.equal(new URL(req.url).origin, origin);
      assert.equal(
        req.headers['proxy-authorization'],
        `Basic ${Buffer.from('fixture:password').toString('base64')}`
      );
      const upstream = http.get(req.url, (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('error', (error) => res.destroy(error));
    });
    const upstreams = new Set();
    t.after(() => {
      for (const socket of upstreams) {
        socket.destroy();
      }
    });
    proxy.on('connect', (req, socket, head) => {
      proxied++;
      assert.equal(`https://${req.url}`, origin);
      assert.equal(
        req.headers['proxy-authorization'],
        `Basic ${Buffer.from('fixture:password').toString('base64')}`
      );
      const upstream = connect(Number(new URL(origin).port), '127.0.0.1');
      upstreams.add(upstream);
      upstream.once('close', () => upstreams.delete(upstream));
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    });
    const proxyUrl = await listen(proxy, t);
    const env = {
      ...cleanEnvironment(),
      ELECTRON_GET_NO_PROGRESS: '1',
      ELECTRON_GET_USE_PROXY: '1',
      GLOBAL_AGENT_HTTP_PROXY: proxyUrl.replace('://', '://fixture:password@'),
      GLOBAL_AGENT_NO_PROXY: mode === 'no-proxy' ? '127.0.0.1' : '',
    };
    if (mode === 'https-proxy') {
      const caPath = path.join(dir, 'fixture-ca.pem');
      await writeFile(caPath, certificate.cert);
      env.NODE_EXTRA_CA_CERTS = caPath;
    }
    await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { readFile } from 'node:fs/promises';
      const { default: get } = await import(${JSON.stringify(entry)});
      assert.ok(globalThis.GLOBAL_AGENT, 'the parent must successfully initialize its proxy');
      const details = {
        isGeneric: true, version: '99.0.0', artifactName: 'fixture.bin',
        mirrorOptions: { mirror: ${JSON.stringify(`${origin}/`)} },
        cacheRoot: ${JSON.stringify(path.join(dir, 'cache'))}, tempDirectory: ${JSON.stringify(dir)},
        checksums: { 'fixture.bin': ${JSON.stringify(mode === 'bad-checksum')} ? '0'.repeat(64) : createHash('sha256').update('loopback artifact').digest('hex') },
        downloadOptions: { quiet: true, retry: { limit: 0 }, timeout: { request: 2000 } },
      };
      if (${JSON.stringify(mode === 'untrusted-tls')}) {
        await assert.rejects(get.downloadArtifact(details), error => /SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code));
      } else if (${JSON.stringify(mode === 'bad-checksum')}) {
        await assert.rejects(get.downloadArtifact(details), /checksum|did not match/i);
      } else {
        const file = await get.downloadArtifact(details);
        assert.equal(await readFile(file, 'utf8'), 'loopback artifact');
        assert.equal(await get.downloadArtifact(details), file, 'second call reuses the verified cache');
      }
    `,
      ],
      { env, maxBuffer: 64 * 1024, timeout: 7000 }
    );
    assert.equal(proxied, mode === 'no-proxy' ? 0 : 1);
    assert.equal(downloads, mode === 'untrusted-tls' ? 0 : 1);
  });
}
