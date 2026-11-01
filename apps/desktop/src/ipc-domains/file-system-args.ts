/** Main-only argument schemas for the desktop file-system contract. */
import { Schema } from 'effect';
import { type ContractArgs, NoArgs } from '../platform/ipc-args';
import type { fileSystemContract } from './file-system.contract';

const OneString = Schema.Tuple([Schema.String]);

export const fileSystemArgs = {
  addRoot: NoArgs,
  addRootByPath: OneString,
  deleteRootData: Schema.Tuple([
    Schema.String.check(
      Schema.makeFilter((rootId) => rootId.trim().length > 0 && rootId.length <= 1024, {
        expected: 'a durable root ID',
      })
    ),
  ]),
  listRecentRoots: NoArgs,
  removeRoot: OneString,
  requestDirectoryAccess: NoArgs,
  restoreLastFolder: NoArgs,
  restoreRoots: NoArgs,
  saveLastFolder: OneString,
} satisfies ContractArgs<typeof fileSystemContract>;
