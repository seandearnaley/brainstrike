#!/usr/bin/env node
// Serves one executable lab scenario on an ephemeral loopback listener until
// SIGINT/SIGTERM, for manual host proofs. Prints the endpoint URL as JSON on
// stdout; every other line goes to stderr. Usage:
//   node scripts/serve-reference-scenario.mjs tasks-reference
import { startMcpLabScenario } from '../dist/lab.js';

const scenarioId = process.argv[2];
if (typeof scenarioId !== 'string' || scenarioId.length === 0) {
  console.error('usage: serve-reference-scenario.mjs <scenario-id>');
  process.exit(2);
}
const lab = await startMcpLabScenario(scenarioId, { execution: 'loopback' });
if (lab.endpoint.kind !== 'loopback-http') {
  await lab.close();
  throw new Error(`scenario ${scenarioId} did not produce a loopback endpoint`);
}
process.stdout.write(`${JSON.stringify({ scenarioId, url: lab.endpoint.url.href })}\n`);
console.error(`serving ${scenarioId} at ${lab.endpoint.url.href}; SIGINT to stop`);
let closing = false;
const shutdown = async (signal) => {
  if (closing) {
    return;
  }
  closing = true;
  console.error(`${signal}: closing`);
  const report = await lab.close();
  console.error(JSON.stringify(report));
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
