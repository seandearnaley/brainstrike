/** Main-only argument schemas for the desktop file-system and watch contracts. */
import type { DirectoryHandle, FileHandle } from '@brainstrike/types';
import { Schema } from 'effect';
import { type ContractArgs, NoArgs } from '../platform/ipc-args';
import type { fileSystemContract, fileSystemWatchContract } from './file-system.contract';

const handleFields = {
  _internal: Schema.optionalKey(Schema.Unknown),
  name: Schema.String,
  path: Schema.String,
  platform: Schema.Literals(['web', 'electron']),
  rootId: Schema.optionalKey(Schema.String),
};

/**
 * A handle is an object Main gave the renderer and the renderer hands back,
 * so it may carry adapter fields (the E2E fixture's `id` and `type`) beyond
 * the declared ones; those pass through untouched, as they always have.
 */
const HandleRest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

const DirectoryHandleSchema: Schema.Decoder<DirectoryHandle> = Schema.StructWithRest(
  Schema.Struct({ ...handleFields, kind: Schema.Literal('directory') }),
  HandleRest
);

const FileHandleSchema: Schema.Decoder<FileHandle> = Schema.StructWithRest(
  Schema.Struct({
    ...handleFields,
    kind: Schema.Literal('file'),
    rootFolderId: Schema.optionalKey(Schema.String),
    size: Schema.optionalKey(Schema.Number),
  }),
  HandleRest
);

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
  exists: OneString,
  listRecentRoots: NoArgs,
  readDirectory: Schema.Tuple([DirectoryHandleSchema]),
  readFile: Schema.Tuple([FileHandleSchema]),
  // The workspace root registry owns the path and root-identity refusals and
  // their bounded audit record; only the shape is decoded here.
  readFileByAbsolutePath: Schema.Tuple([Schema.String, Schema.String, Schema.String]),
  readFileByPath: OneString,
  removeRoot: OneString,
  requestDirectoryAccess: NoArgs,
  restoreLastFolder: NoArgs,
  restoreRoots: NoArgs,
  saveLastFolder: OneString,
} satisfies ContractArgs<typeof fileSystemContract>;

export const fileSystemWatchArgs = {
  getWatcherTelemetry: NoArgs,
  retryWatch: OneString,
  unwatchDirectory: OneString,
  watchDirectory: Schema.Tuple([DirectoryHandleSchema]),
} satisfies ContractArgs<typeof fileSystemWatchContract>;
