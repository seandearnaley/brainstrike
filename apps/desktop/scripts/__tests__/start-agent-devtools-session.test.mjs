import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import agentDevToolsDefaults from '../../agent-devtools-defaults.json' with { type: 'json' };
import {
  formatMcpConfig,
  parsePort,
  resolveEndpoint,
  waitForEndpoint,
  waitForEndpointOrChildExit,
} from '../start-agent-devtools-session.mjs';

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
