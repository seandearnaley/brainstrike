import assert from 'node:assert/strict';

const entry = await import('../dist/index.js');

assert.equal(typeof entry.startMcpLabScenario, 'function');
assert.equal(typeof entry.parseMcpEvidenceBundle, 'function');
assert.equal(typeof entry.createMcpLabFaultPlan, 'function');
