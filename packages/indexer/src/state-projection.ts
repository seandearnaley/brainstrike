import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { StateProjectionOptions } from './contracts.js';
import { createStateProjection, type StateProjection } from './state-producer.js';

export {
  createStateProjection,
  type StateMessageEvent,
  type StateProducerDecoder,
  type StateProjection,
  type StateProjectionRow,
} from './state-producer.js';

export function validateStateModule(module: string): string {
  const url = new URL(module);
  if (url.protocol !== 'file:' || url.search || url.hash) {
    throw new TypeError('State projection requires an explicit canonical local file module.');
  }
  const filename = fileURLToPath(url);
  if (pathToFileURL(realpathSync(filename)).href !== url.href) {
    throw new TypeError('State projection requires an explicit canonical local file module.');
  }
  return filename;
}

/**
 * The desktop's producer, loaded by file URL: only the trusted acquisition
 * owner supplies this module, and its callbacks stay in the writer. Its
 * identity covers the module's own source, so editing the producer rebuilds
 * the index (the host state index does so automatically).
 */
export async function loadStateProjection(
  options: StateProjectionOptions,
  stateRoot?: string
): Promise<StateProjection> {
  const filename = validateStateModule(options.module);
  const producer = await import(options.module);
  const identity = createHash('sha256')
    .update(JSON.stringify([options.module, options.mode, readFileSync(filename, 'utf8')]))
    .digest('hex');
  return createStateProjection(producer, options.mode, identity, stateRoot);
}
