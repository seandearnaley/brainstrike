import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
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

/** Relative module specifiers a source file imports or re-exports statically. */
const RELATIVE_IMPORT =
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * The producer's implementation: its module and every module it reaches by
 * relative import, with their sources, in a stable order. Package imports
 * are not followed; their versions belong to the build.
 */
function producerSources(entry: string): readonly (readonly [string, string])[] {
  const root = path.dirname(entry);
  const sources = new Map<string, string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (sources.has(file)) {
      continue;
    }
    const source = readFileSync(file, 'utf8');
    sources.set(file, source);
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (specifier) {
        pending.push(path.resolve(path.dirname(file), specifier));
      }
    }
  }
  return [...sources]
    .map(([file, source]) => [path.relative(root, file).split(path.sep).join('/'), source] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The desktop's producer, loaded by file URL: only the trusted acquisition
 * owner supplies this module, and its callbacks stay in the writer. Its
 * identity covers the producer's implementation (`producerSources`), so
 * changing any module the producer reaches rebuilds the index (the host state
 * index does so automatically).
 */
export async function loadStateProjection(
  options: StateProjectionOptions,
  stateRoot?: string
): Promise<StateProjection> {
  const filename = validateStateModule(options.module);
  const producer = await import(options.module);
  const identity = createHash('sha256')
    .update(JSON.stringify([options.module, options.mode, producerSources(filename)]))
    .digest('hex');
  return createStateProjection(producer, options.mode, identity, stateRoot);
}
