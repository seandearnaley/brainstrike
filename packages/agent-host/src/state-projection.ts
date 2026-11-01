/**
 * The desktop's state producer module, which the derived indexer loads by
 * file URL (`loadStateProjection`): the portable host producer reading the
 * data root's blob files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOBS_DIR, type Mode } from '@brainstrike/state-store';
import { type DecodedHostEvent, decodeHostRow } from './host-state-producer.ts';

export { search, text } from './host-state-producer.ts';

export function decode(raw: string, mode: Mode, stateRoot?: string): DecodedHostEvent {
  return decodeHostRow(
    raw,
    mode,
    stateRoot ? (hash) => readFileSync(join(stateRoot, BLOBS_DIR, hash)) : undefined
  );
}
