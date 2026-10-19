import { enableCompileCache } from 'node:module';

// The forked agent host's entry. Node's on-disk compile cache must be on before
// the host's large static module graph is compiled, so this entry enables it
// and only then loads the host process.
// https://nodejs.org/api/module.html#moduleenablecompilecachecachedir
enableCompileCache();
// For this thread only (BST-2239). Node persists what an instance compiled when
// it exits, and the state index's worker and nested writer exit inside the
// index's 1 s close and 1 s exit windows: cold on hosted Windows that persist
// took 1.6 s and 4 s, so the host failed its cleanup and kept its Root. A
// launcher's NODE_COMPILE_CACHE would carry the cache into them, so it stops here.
delete process.env['NODE_COMPILE_CACHE'];
const { runAgentHostProcess } = await import('./process-entry.js');
try {
  await runAgentHostProcess(process.argv.slice(2));
} catch (cause) {
  process.exitCode = 1;
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
}
