// Exercise the exact desktop initializer without starting an Electron UI.
// @boundaries-ignore Integration fixture compares the real desktop initializer with the Node host; agent-host must not depend on the desktop application.
await import('../../../../apps/desktop/src/agent-host-compile-cache.ts');
const { runAgentHostProcess } = await import('../../dist/process-entry.js');
await runAgentHostProcess(process.argv.slice(2));
