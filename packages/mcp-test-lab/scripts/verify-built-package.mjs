import assert from 'node:assert/strict';

const entry = await import('../dist/index.js');
const scenario = await import('../dist/scenario.js');

assert.equal(typeof entry.getMcpLabScenario, 'function');
assert.equal(typeof entry.createMcpLabFaultPlan, 'function');
assert.equal(typeof entry.isMcpLabFaultPlan, 'function');
assert.equal(entry.MCP_LAB_SDK_VERSION, '2.0.0');
assert.equal(typeof scenario.getMcpLabScenario, 'function');
assert.equal(scenario.MCP_LAB_SDK_VERSION, '2.0.0');
