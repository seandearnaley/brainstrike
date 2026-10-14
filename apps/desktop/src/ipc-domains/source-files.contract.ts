import type { SourceFilesCapability } from '@brainstrike/assistant-contract';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  channel,
  parseNoArgs,
} from '../platform/ipc-contract';
import { assertArgCount, assertSupportedKeys, parseRecord } from './contract-args';

function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Source identity is required.');
  }
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Source bound must be a nonnegative integer.');
  }
  return value;
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 250) {
    throw new Error('Source batch exceeds 250 files.');
  }
  return value.map(identity);
}
function chunks(raw: readonly unknown[]): Parameters<SourceFilesCapability['chunks']> {
  assertArgCount(raw, 1, 'Source chunks');
  const row = parseRecord(raw[0], 'Source chunks');
  assertSupportedKeys(row, ['fileId', 'offset', 'limit', 'expected'], 'Source chunks');
  const limit = integer(row['limit']);
  if (limit < 1 || limit > 100) {
    throw new Error('Source chunk page must contain 1 to 100 rows.');
  }
  const base = { fileId: identity(row['fileId']), limit, offset: integer(row['offset']) };
  if (row['expected'] === undefined) {
    return [base];
  }
  const expected = parseRecord(row['expected'], 'Source snapshot');
  assertSupportedKeys(expected, ['contentHash', 'snapshotHash', 'profileHash'], 'Source snapshot');
  return [
    {
      ...base,
      expected: {
        contentHash: identity(expected['contentHash']),
        profileHash: expected['profileHash'] === null ? null : identity(expected['profileHash']),
        snapshotHash: identity(expected['snapshotHash']),
      },
    },
  ];
}
function imports(raw: readonly unknown[]): Parameters<SourceFilesCapability['import']> {
  assertArgCount(raw, 1, 'Source import');
  const row = parseRecord(raw[0], 'Source import');
  assertSupportedKeys(row, ['embeddingSetId', 'files'], 'Source import');
  if (!Array.isArray(row['files']) || row['files'].length > 250) {
    throw new Error('Source batch exceeds 250 files.');
  }
  return [
    {
      embeddingSetId: row['embeddingSetId'] === null ? null : identity(row['embeddingSetId']),
      files: row['files'].map((value) => {
        const file = parseRecord(value, 'Imported file');
        assertSupportedKeys(file, ['name', 'path', 'content', 'size'], 'Imported file');
        if (typeof file['content'] !== 'string') {
          throw new Error('Imported file content must be text.');
        }
        return {
          content: file['content'],
          name: identity(file['name']),
          path: identity(file['path']),
          size: integer(file['size']),
        };
      }),
    },
  ];
}
export const sourceFilesContract = {
  chunks: channel<
    Parameters<SourceFilesCapability['chunks']>,
    Awaited<ReturnType<SourceFilesCapability['chunks']>>
  >({ channel: DESKTOP_IPC_CHANNELS.sourceFiles.chunks, parseArgs: chunks, roles: ['visible-ui'] }),
  delete: channel<Parameters<SourceFilesCapability['delete']>, void>({
    channel: DESKTOP_IPC_CHANNELS.sourceFiles.delete,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'Source delete');
      return [ids(raw[0])];
    },
    roles: ['visible-ui'],
  }),
  import: channel<
    Parameters<SourceFilesCapability['import']>,
    Awaited<ReturnType<SourceFilesCapability['import']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.sourceFiles.import,
    parseArgs: imports,
    roles: ['visible-ui'],
  }),
  list: channel<[], Awaited<ReturnType<SourceFilesCapability['list']>>>({
    channel: DESKTOP_IPC_CHANNELS.sourceFiles.list,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
  read: channel<
    Parameters<SourceFilesCapability['read']>,
    Awaited<ReturnType<SourceFilesCapability['read']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.sourceFiles.read,
    parseArgs: (raw) => {
      assertArgCount(raw, 2, 'Source read');
      return [ids(raw[0]), integer(raw[1])];
    },
    roles: ['visible-ui', 'chunking-host'],
  }),
};
export type SourceFilesBridgeProof = AssertTrue<
  BridgeMatches<typeof sourceFilesContract, SourceFilesCapability>
>;
