import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isMainThread } from 'node:worker_threads';

const receipt = process.env.BRAINSTRIKE_M3_WORKSPACE_RECEIPT;
if (!receipt) {
  throw new Error('Workspace boundary fixture requires a disposable receipt');
}
appendFileSync(
  receipt,
  `${JSON.stringify({
    electron: process.versions.electron ?? null,
    event: 'process-start',
    isMainThread,
    pid: process.pid,
  })}\n`
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron' || specifier === '@napi-rs/keyring') {
      throw new Error('Workspace input qualification forbids Electron and OS keyring access');
    }
    return nextResolve(specifier, context);
  },
});
// Cold workspace services are unavailable in this packet. Any inference is a defect,
// not a synthetic workspace executor or a successful retrieval receipt.
globalThis.fetch = () => {
  appendFileSync(receipt, `${JSON.stringify({ event: 'unexpected-http', pid: process.pid })}\n`);
  throw new Error('Pure workspace input qualification must not issue HTTP');
};
