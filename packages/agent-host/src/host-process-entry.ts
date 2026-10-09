import { enableCompileCache } from 'node:module';

// The forked agent host's entry. Node's on-disk compile cache must be on before
// the host's large static module graph is compiled, so this entry enables it
// and only then loads the host process.
// https://nodejs.org/api/module.html#moduleenablecompilecachecachedir
enableCompileCache();
const { runAgentHostProcess } = await import('./process-entry.js');
try {
  await runAgentHostProcess(process.argv.slice(2));
} catch (cause) {
  process.exitCode = 1;
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
}
