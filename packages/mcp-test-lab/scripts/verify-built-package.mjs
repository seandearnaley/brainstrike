import assert from 'node:assert/strict';

const entry = await import('../dist/index.js');

assert.equal(typeof entry.getMcpLabScenario, 'function');
assert.equal(entry.MCP_LAB_SDK_VERSION, '2.0.0');
