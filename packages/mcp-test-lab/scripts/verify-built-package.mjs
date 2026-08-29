import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';

const entry = await import('../dist/index.js');
const evidence = await import('../dist/evidence.js');
const lab = await import('../dist/lab.js');
const scenario = await import('../dist/scenario.js');

assert.equal(typeof entry.getMcpLabScenario, 'function');
assert.equal(typeof entry.verifyMcpEvidenceBundle, 'function');
assert.equal('verifyMcpEvidenceArtifactIntegrity' in entry, false);
assert.equal('parseMcpEvidenceSchema' in entry, false);
assert.equal(typeof entry.createMcpLabFaultPlan, 'function');
assert.equal(typeof entry.isMcpLabFaultPlan, 'function');
assert.equal(typeof entry.startMcpLabScenario, 'function');
assert.equal(entry.MCP_LAB_SDK_VERSION, '2.0.0');
assert.equal(typeof evidence.verifyMcpEvidenceBundle, 'function');
assert.equal('verifyMcpEvidenceArtifactIntegrity' in evidence, false);
assert.equal('parseMcpEvidenceSchema' in evidence, false);
assert.equal(evidence.MCP_EVIDENCE_SCHEMA_VERSION, '1.0.0');
assert.equal(typeof lab.startMcpLabScenario, 'function');
assert.equal(typeof scenario.getMcpLabScenario, 'function');
assert.equal(scenario.MCP_LAB_SDK_VERSION, '2.0.0');
await access(new URL('../fixtures/stdio-reference-server.mjs', import.meta.url));
