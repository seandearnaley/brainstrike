/** Main-only argument schemas for the desktop file-system contract. */
import { Schema } from 'effect';
import type { ContractArgs } from '../platform/ipc-args';
import type { fileSystemContract } from './file-system.contract';

export const fileSystemArgs = {
  deleteRootData: Schema.Tuple([
    Schema.String.check(
      Schema.makeFilter((rootId) => rootId.trim().length > 0 && rootId.length <= 1024, {
        expected: 'a durable root ID',
      })
    ),
  ]),
} satisfies ContractArgs<typeof fileSystemContract>;
