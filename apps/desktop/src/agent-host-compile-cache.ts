import { enableCompileCache } from 'node:module';

// Node's documented on-disk V8 code cache (its default directory under the OS
// temp dir): the host's module graph (Mastra, the AI SDK) compiles once, not
// at every host start. It must run before the host's modules load, so the
// entry imports this module first.
// https://nodejs.org/api/module.html#moduleenablecompilecacheoptions
enableCompileCache();
// For this thread only (BST-2239). Node persists what an instance compiled when
// it exits, and the state index's worker and nested writer exit inside the
// index's 1 s close and 1 s exit windows: cold on hosted Windows that persist
// took 1.6 s and 4 s, so the host failed its cleanup and kept its Root. A
// launcher's NODE_COMPILE_CACHE would carry the cache into them, so it stops here.
delete process.env['NODE_COMPILE_CACHE'];
