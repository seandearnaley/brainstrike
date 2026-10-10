import { enableCompileCache } from 'node:module';

// Node's documented on-disk V8 code cache (its default directory under the OS
// temp dir): the host's module graph (Mastra, the AI SDK) compiles once, not
// at every host start. It must run before the host's modules load, so the
// entry imports this module first.
const cache = enableCompileCache();
if (cache.directory) {
  // Node enables only this instance; its documented environment setting also
  // enables the real index engine and nested writer before their imports.
  // https://nodejs.org/api/module.html#moduleenablecompilecacheoptions
  process.env['NODE_COMPILE_CACHE'] = cache.directory;
}
