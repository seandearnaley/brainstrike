// Preloaded with `--import` into every process of a CLI proof: appends each
// module URL the process resolves (ESM and CommonJS alike) to the file named by
// BRAINSTRIKE_TEST_MODULE_LOG, so the proof can show which code ran.
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const log = process.env.BRAINSTRIKE_TEST_MODULE_LOG;
if (!log) {
  throw new Error('BRAINSTRIKE_TEST_MODULE_LOG names no module log');
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    appendFileSync(log, `${process.pid}\t${resolved.url}\n`);
    return resolved;
  },
});
