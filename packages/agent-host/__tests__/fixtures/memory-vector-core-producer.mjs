import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../../dist/state-projection.js';

// Instrument only the original writer callback; all producer logic is the emitted Core entry.
let acquiredRoot;

export function decode(raw, mode, stateRoot) {
  acquiredRoot = stateRoot;
  return core.decode(raw, mode, stateRoot);
}

export const text = core.text;

export function messages(rows) {
  // Linux qualification holds the actual writer callback, not a fake port result.
  // These temporary control files are never a product lifecycle capability.
  if (acquiredRoot && existsSync(join(acquiredRoot, '.memory-vector-pause'))) {
    unlinkSync(join(acquiredRoot, '.memory-vector-pause'));
    writeFileSync(join(acquiredRoot, '.memory-vector-entered'), 'messages');
    readFileSync(join(acquiredRoot, '.memory-vector-release.fifo'));
  }
  return core.messages(rows);
}
