import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

// GHSA-vc2v-76pw-4v95: release the compression stream on premature response close.
function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('compression@'))
    .map((key) => key.slice('compression@'.length));
  assert.ok(versions.length > 0, 'expected compression in the graph');
  for (const version of versions) {
    assert.match(version, /^1\.\d+\.\d+$/, 'review an unknown compression release line');
    const [, minor, patch] = version.split('.').map(Number);
    assert.ok(minor > 8 || (minor === 8 && patch >= 2), `vulnerable compression@${version}`);
  }
}

test('the full graph excludes vulnerable compression, with negative controls', async () => {
  assertPatched(parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
  for (const version of ['1.7.5', '1.8.0', '1.8.1']) {
    assert.throws(
      () => assertPatched({ packages: { [`compression@${version}`]: {} } }),
      /vulnerable/
    );
  }
  assertPatched({ packages: { 'compression@1.8.2': {} } });
  assert.throws(() => assertPatched({ packages: {} }), /expected compression/);
});

test('serve compresses responses and destroys the gzip stream when the client disconnects', {
  timeout: 5000,
}, async (t) => {
  const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
  const serveRequire = createRequire(webRequire.resolve('serve/package.json'));
  const compress = serveRequire('compression')({ threshold: 0 });
  const streams = [];
  const createGzip = zlib.createGzip;
  // Observe the real native stream; compression and the HTTP connection are real.
  t.mock.method(zlib, 'createGzip', (...args) => {
    const stream = createGzip(...args);
    streams.push(stream);
    return stream;
  });
  const payload = 'preview asset\n'.repeat(1000);
  const aborted = Promise.withResolvers();
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    compress(req, res, () => {
      if (req.url === '/abort') {
        res.once('close', aborted.resolve);
        res.write(payload);
        res.flush();
        return;
      }
      res.end(payload);
    });
  });
  t.after(async () => {
    for (const stream of streams) {
      stream.destroy();
    }
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = get(base, { headers: { 'Accept-Encoding': 'gzip' } });
  const [response] = await once(request, 'response');
  assert.equal(response.headers['content-encoding'], 'gzip');
  const chunks = [];
  for await (const chunk of response) {
    chunks.push(chunk);
  }
  assert.equal(zlib.gunzipSync(Buffer.concat(chunks)).toString(), payload);

  const abortRequest = get(`${base}/abort`, { headers: { 'Accept-Encoding': 'gzip' } });
  const [abortResponse] = await once(abortRequest, 'response');
  assert.equal(abortResponse.headers['content-encoding'], 'gzip');
  await once(abortResponse, 'data');
  abortResponse.destroy();
  await aborted.promise;
  await setImmediate();
  assert.equal(streams.length, 2);
  assert.equal(streams[1].destroyed, true, 'client disconnect must release its compression stream');
});
