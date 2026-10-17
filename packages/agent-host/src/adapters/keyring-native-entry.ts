import { parentPort, workerData } from 'node:worker_threads';
import { AsyncEntry, findCredentialsAsync } from '@napi-rs/keyring';
import { Schema } from 'effect';
import {
  type KeyringNativeRequest,
  KeyringNativeRequestSchema,
} from './keyring-native-protocol.js';

const { service } = Schema.decodeUnknownSync(
  Schema.Struct({ service: Schema.String.check(Schema.isMinCodePoints(1)) }),
  { errors: 'all', onExcessProperty: 'error' }
)(workerData);
const port = parentPort;
if (!port) {
  throw new Error('Credential worker requires its private owner channel');
}
const pending = new Set<Promise<unknown>>();
let closing = false;
async function execute(
  request: KeyringNativeRequest
): Promise<string | boolean | readonly string[] | null> {
  if (request.operation === 'close') {
    closing = true;
    await Promise.allSettled([...pending]);
    return null;
  }
  if (closing) {
    throw new Error('Credential worker is closing');
  }
  if (request.operation === 'listAccounts') {
    // Upstream's Linux enumeration directly uses Secret Service, with no keyutils fallback.
    // https://github.com/Brooooooklyn/keyring-node/blob/1635ed458e8349ba28233728a8238ad99a5b2817/src/entry.rs
    return (await findCredentialsAsync(service)).map((credential) => credential.account);
  }
  // Even construction is synchronous upstream. Keep it on this owned worker.
  // No AbortSignal is handed to NAPI: cancellation cannot discard native completion.
  const entry = new AsyncEntry(service, request.account, { linux: { store: 'secret-service' } });
  switch (request.operation) {
    case 'read':
      return (await entry.getPassword()) ?? null;
    case 'write':
      await entry.setPassword(request.value);
      return null;
    case 'delete':
      return await entry.deleteCredential();
  }
}
port.on('message', (input: unknown) => {
  const request = Schema.decodeUnknownSync(KeyringNativeRequestSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(input);
  const operation = execute(request);
  if (request.operation !== 'close') {
    pending.add(operation);
  }
  operation.then(
    (value) => {
      pending.delete(operation);
      port.postMessage({ id: request.id, ok: true, value });
      if (request.operation === 'close') {
        port.close();
      }
    },
    () => {
      pending.delete(operation);
      // Native failure strings may contain account/service details. Keep them off logs and IPC.
      port.postMessage({ id: request.id, ok: false });
    }
  );
});
