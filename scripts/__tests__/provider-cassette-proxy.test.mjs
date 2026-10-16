import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const proxyPath = fileURLToPath(new URL('../provider-cassette-proxy.mjs', import.meta.url));

/** A local stand-in provider answering every request with `body`. */
async function standIn(body) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** Starts the proxy, sends one request through the OpenRouter knob, then interrupts it. */
async function recordOnce(upstreamBody) {
  const directory = mkdtempSync(join(tmpdir(), 'bs-cassette-proxy-'));
  const out = join(directory, 'capture.json');
  const { server, url } = await standIn(upstreamBody);
  const proxy = spawn(
    process.execPath,
    [proxyPath, '--out', out, '--upstream', `OPENROUTER_BASE_URL=${url}/api/v1`],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  proxy.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  proxy.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  while (!stdout.includes('Recording.')) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const base = /OPENROUTER_BASE_URL=(\S+)/u.exec(stdout)?.[1];
  const response = await fetch(`${base}/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: `Read ${homedir()}/notes.md`, role: 'user' }],
      model: 'z-ai/glm-fixture',
      stream: true,
    }),
    headers: { Authorization: 'Bearer proxy-test-credential', 'Content-Type': 'application/json' },
    method: 'POST',
  });
  assert.equal(await response.text(), upstreamBody);
  proxy.kill('SIGINT');
  const [code] = await once(proxy, 'exit');
  server.close();
  return { code, directory, out, stderr, stdout };
}

test('the cassette proxy records a sanitized exchange and writes it on interrupt', async () => {
  const { code, directory, out, stdout } = await recordOnce(
    'data: {"delta":"hi"}\n\ndata: [DONE]\n\n'
  );
  try {
    assert.equal(code, 0);
    assert.match(stdout, /Wrote 1 exchanges/u);
    const text = readFileSync(out, 'utf8');
    assert.doesNotMatch(text, /proxy-test-credential/u);
    assert.ok(!text.includes(homedir()), 'the home directory is substituted in requests');
    const cassette = JSON.parse(text);
    assert.equal(cassette.format, 'brainstrike.provider-cassette/1');
    assert.equal(cassette.scenario, 'capture');
    assert.equal(cassette.exchanges[0].key.lane, 'Read ~/notes.md');
    assert.equal(cassette.exchanges[0].response.body, 'data: {"delta":"hi"}\n\ndata: [DONE]\n\n');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('the cassette proxy writes nothing when a response holds a local path', async () => {
  const { code, directory, out, stderr } = await recordOnce(`data: {"delta":"${homedir()}"}\n\n`);
  try {
    assert.equal(code, 1);
    assert.match(stderr, /home-directory in response of exchange 0/u);
    assert.ok(!existsSync(out));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('the cassette proxy writes nothing when a response holds a secret-looking string', async () => {
  const key = `sk-or-v1-${'0123456789abcdef'.repeat(4)}`;
  const { code, directory, out, stderr } = await recordOnce(`data: {"delta":"${key}"}\n\n`);
  try {
    assert.equal(code, 1);
    assert.match(stderr, /openrouter-api-key in line \d+/u);
    assert.ok(!stderr.includes(key), 'the finding never echoes the value');
    assert.ok(!existsSync(out));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
