import { appendFileSync, mkdirSync } from 'node:fs';
import { enableCompileCache } from 'node:module';
import { join } from 'node:path';

// Node's documented on-disk V8 code cache (its default directory under the OS
// temp dir): the host's module graph (Mastra, the AI SDK) compiles once, not
// at every host start. It must run before the host's modules load, so the
// entry imports this module first.
const cache = enableCompileCache();
// BST-2239 proof only: the packaged Windows utility's stderr never reaches the harness.
{
  const line = JSON.stringify({
    directory: cache.directory,
    msg: 'BST-2239 host compile cache',
    pid: process.pid,
    status: cache.status,
    time: new Date().toISOString(),
  });
  process.stderr.write(`${line}\n`);
  const userData = process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'];
  if (userData) {
    mkdirSync(join(userData, 'logs'), { recursive: true });
    appendFileSync(join(userData, 'logs', 'agent-host-timing.ndjson'), `${line}\n`);
  }
}
if (cache.directory) {
  // Node enables only this instance; its documented environment setting also
  // enables the real index engine and nested writer before their imports.
  // https://nodejs.org/api/module.html#moduleenablecompilecacheoptions
  process.env['NODE_COMPILE_CACHE'] = cache.directory;
}
