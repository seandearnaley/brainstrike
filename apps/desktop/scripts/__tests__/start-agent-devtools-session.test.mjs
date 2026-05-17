import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatMcpConfig,
  parsePort,
  resolveEndpoint,
} from '../start-agent-devtools-session.mjs';

test('parsePort accepts a valid explicit port', () => {
  assert.equal(parsePort('9333'), 9333);
});

test('parsePort rejects privileged or invalid ports', () => {
  assert.throws(() => parsePort('80'), /integer from 1024 to 65535/);
  assert.throws(() => parsePort('abc'), /integer from 1024 to 65535/);
});

test('resolveEndpoint returns the local browser url', () => {
  assert.equal(resolveEndpoint(9222), 'http://127.0.0.1:9222');
});

test('formatMcpConfig renders chrome-devtools-mcp browser-url config', () => {
  const rendered = formatMcpConfig('http://127.0.0.1:9222');
  assert.match(rendered, /chrome-devtools-mcp@latest/);
  assert.match(rendered, /--browser-url=http:\/\/127\.0\.0\.1:9222/);
  assert.match(rendered, /--no-usage-statistics/);
});
