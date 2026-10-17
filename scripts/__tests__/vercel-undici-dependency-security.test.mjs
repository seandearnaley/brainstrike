import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
function ownerRequire(owner) {
  const rootRequire = createRequire(path.join(root, 'package.json'));
  const vercelRequire = createRequire(rootRequire.resolve('vercel/package.json'));
  return owner === 'vercel' ? vercelRequire : createRequire(vercelRequire.resolve('@vercel/node'));
}

function assertPatched(lock) {
  for (const owner of ['vercel', '@vercel/node']) {
    const snapshots = Object.entries(lock.snapshots).filter(([key]) => key.startsWith(`${owner}@`));
    assert.ok(snapshots.length > 0, `missing ${owner} owner`);
    for (const [, snapshot] of snapshots) {
      const version = snapshot.dependencies?.undici;
      assert.match(version ?? '', /^7\.\d+\.\d+$/, `${owner} needs a qualified Undici major`);
      const [, minor, patch] = version.split('.').map(Number);
      assert.ok(
        minor > 30 || (minor === 30 && patch >= 1),
        `${owner}: vulnerable undici@${version}`
      );
    }
  }
  assert.ok(
    !Object.keys(lock.packages).some((key) => /^undici@[0-5]\./.test(key)),
    'old Undici remains'
  );
  assert.ok(
    !Object.keys(lock.packages).some((key) => /^@fastify\/busboy@[12]\./.test(key)),
    'old busboy remains'
  );
}

test('both Vercel owners resolve patched Undici without leaving the old graph behind', async () => {
  const fixture = (version) => ({
    packages: { [`undici@${version}`]: {} },
    snapshots: Object.fromEntries(
      ['vercel@64.3.1', '@vercel/node@24.0.2'].map((key) => [
        key,
        { dependencies: { undici: version } },
      ])
    ),
  });
  for (const version of ['5.28.4', '5.29.0', '6.29.1', '7.29.1', '7.30.0']) {
    assert.throws(() => assertPatched(fixture(version)));
  }
  const patched = fixture('7.30.1');
  assertPatched(patched);
  for (const old of ['undici@5.29.0', '@fastify/busboy@2.1.1']) {
    assert.throws(() =>
      assertPatched({ ...patched, packages: { ...patched.packages, [old]: {} } })
    );
  }
  assert.throws(() => assertPatched({ packages: {}, snapshots: {} }), /missing/);
  assertPatched(parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
});

for (const owner of ['vercel', '@vercel/node']) {
  test(`${owner}'s multipart parser handles files and prototype-named headers without busboy`, () => {
    const entry = ownerRequire(owner).resolve('undici');
    // Bound the old busboy denial-of-service reproduction to a disposable process.
    const result = spawnSync(
      process.execPath,
      [
        '--eval',
        `
      const assert = require('node:assert/strict');
      const { Response } = require(${JSON.stringify(entry)});
      (async () => {
        for (const header of ['', 'constructor: ignored\\r\\n', '__proto__: ignored\\r\\n']) {
          const body = '--boundary\\r\\n' + header +
            'Content-Disposition: form-data; name="upload"; filename="hello.txt"\\r\\n' +
            'Content-Type: text/plain\\r\\n\\r\\nhello\\r\\n--boundary--\\r\\n';
          const form = await new Response(body, { headers: { 'content-type': 'multipart/form-data; boundary=boundary' } }).formData();
          assert.equal(form.get('upload').name, 'hello.txt');
          assert.equal(await form.get('upload').text(), 'hello');
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
      ],
      { encoding: 'utf8', timeout: 5000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}

async function listen(server, t) {
  const connections = new Set();
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  t.after(async () => {
    for (const socket of connections) {
      socket.destroy();
    }
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('the shipped CLI fetch and proxy dispatcher preserve uploads, cookies and NO_PROXY on Node', {
  timeout: 10_000,
}, async (t) => {
  const vercelRequire = ownerRequire('vercel');
  const chunks = path.join(
    path.dirname(vercelRequire.resolve('vercel/package.json')),
    'dist/chunks'
  );
  const names = await readdir(chunks);
  const proxyFiles = names.filter((name) => /^fetch-proxy-.*\.js$/.test(name));
  assert.equal(proxyFiles.length, 1, 'review a changed Vercel proxy layout');
  const fetchFiles = [];
  for (const name of names.filter((name) => name.endsWith('.js'))) {
    if (
      (await readFile(path.join(chunks, name), 'utf8')).includes('function setFetchDispatcher(')
    ) {
      fetchFiles.push(name);
    }
  }
  assert.equal(fetchFiles.length, 1, 'review a changed Vercel fetch layout');
  const { EnvProxyDispatcher } = await import(pathToFileURL(path.join(chunks, proxyFiles[0])));
  const cli = await import(pathToFileURL(path.join(chunks, fetchFiles[0])));
  const origin = await listen(
    createServer(async (req, res) => {
      const body = [];
      for await (const chunk of req) {
        body.push(chunk);
      }
      res.setHeader('Set-Cookie', ['first=1; Path=/', 'second=2; Path=/']);
      res.end(`${req.method}:${Buffer.concat(body)}`);
    }),
    t
  );
  const sockets = new Set();
  let tunnels = 0;
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels++;
    const target = new URL(`http://${req.url}`);
    assert.equal(target.origin, origin, 'fixture must only proxy its local origin');
    const upstream = connect(Number(target.port), target.hostname);
    for (const connection of [socket, upstream]) {
      sockets.add(connection);
      connection.once('close', () => sockets.delete(connection));
      connection.on('error', () => {
        socket.destroy();
        upstream.destroy();
      });
    }
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  const proxyUrl = await listen(proxy, t);
  // Isolate host proxy settings; all connections stay on loopback.
  const envNames = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ];
  const saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) {
    delete process.env[name];
  }
  process.env.HTTP_PROXY = proxyUrl;
  const dispatcher = new EnvProxyDispatcher();
  cli.setFetchDispatcher(dispatcher);
  t.after(async () => {
    cli.setFetchDispatcher(undefined);
    for (const name of envNames) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await dispatcher.destroy();
  });
  const response = await cli.fetch(origin, {
    body: Readable.from(['upload']),
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(await response.text(), 'POST:upload');
  assert.deepEqual(response.headers.getSetCookie(), ['first=1; Path=/', 'second=2; Path=/']);
  assert.equal(tunnels, 1);
  process.env.NO_PROXY = '127.0.0.1';
  assert.equal(
    await (await cli.fetch(origin, { signal: AbortSignal.timeout(3000) })).text(),
    'GET:'
  );
  assert.equal(tunnels, 1, 'NO_PROXY must bypass the CONNECT proxy');
});

for (const extension of ['cjs', 'mjs']) {
  test(`Vercel's ${extension === 'cjs' ? 'buffered' : 'streaming'} function bridge preserves POST bodies and cookies`, {
    timeout: 10_000,
  }, async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'bst-887-function-'));
    const entrypoint = `handler.${extension}`;
    await writeFile(
      path.join(fixture, entrypoint),
      `${extension === 'cjs' ? 'module.exports =' : 'export default'} async function(req, res) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      res.statusCode = 201;
      res.setHeader('Set-Cookie', ['first=1; Path=/', 'second=2; Path=/']);
      res.write(req.method + ':'); res.end(Buffer.concat(chunks));
    }`
    );
    const worker = path.join(
      path.dirname(ownerRequire('vercel').resolve('@vercel/node')),
      'dev-server.mjs'
    );
    const child = fork(worker, [], {
      cwd: fixture,
      env: {
        PATH: process.env.PATH,
        VERCEL_DEV_CONFIG: '{"helpers":false}',
        VERCEL_DEV_ENTRYPOINT: entrypoint,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let diagnostics = '';
    child.stdout.on('data', (chunk) => {
      diagnostics += chunk;
    });
    child.stderr.on('data', (chunk) => {
      diagnostics += chunk;
    });
    const exited = once(child, 'exit');
    t.after(async () => {
      child.kill('SIGKILL');
      await exited;
      await rm(fixture, { force: true, recursive: true });
    });
    const [address] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const response = await fetch(`http://127.0.0.1:${address.port}/test`, {
      body: 'function upload',
      headers: { 'x-forwarded-host': 'fixture.invalid' },
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 201, diagnostics);
    assert.equal(await response.text(), 'POST:function upload');
    assert.deepEqual(response.headers.getSetCookie(), ['first=1; Path=/', 'second=2; Path=/']);
    child.send('shutdown');
    const [code] = await exited;
    assert.equal(code, 0, diagnostics);
  });
}
