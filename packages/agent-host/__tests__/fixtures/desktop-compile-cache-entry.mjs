// Exercise the exact desktop initializer without starting an Electron UI.
await import('../../../../apps/desktop/src/agent-host-compile-cache.ts');
const { runAgentHostProcess } = await import('../../dist/process-entry.js');
await runAgentHostProcess(process.argv.slice(2));
