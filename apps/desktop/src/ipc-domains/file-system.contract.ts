/** Pure contracts for the visible-UI desktop file-system bridge. */
import type { ElectronFileSystemAPI } from '@brainstrike/types';
import type { FileReadErrorPayload } from '../file-read-errors';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type Bridge,
  type Contract,
  pushEvent,
  rawChannel,
} from '../platform/ipc-contract';
import { assertArgCount, parseRecord } from './contract-args';

type ReadMethod = 'readFile' | 'readFileByAbsolutePath' | 'readFileByPath';
type InvokeArgs<K extends keyof ElectronFileSystemAPI> = Parameters<ElectronFileSystemAPI[K]>;
type InvokeResult<K extends keyof ElectronFileSystemAPI> = Awaited<
  ReturnType<ElectronFileSystemAPI[K]>
>;
type FileReadWireResult = string | FileReadErrorPayload;

function parseNoArguments(raw: readonly unknown[], subject: string): [] {
  assertArgCount(raw, 0, subject);
  return [];
}

function parseString(raw: readonly unknown[], subject: string): [value: string] {
  assertArgCount(raw, 1, subject);
  if (typeof raw[0] !== 'string') {
    throw new Error(`${subject} requires a string`);
  }
  return [raw[0]];
}

function parseHandle<T>(raw: readonly unknown[], subject: string): [handle: T] {
  assertArgCount(raw, 1, subject);
  const handle = parseRecord(raw[0], `${subject} handle`);
  if (typeof handle['path'] !== 'string') {
    throw new Error(`${subject} handle path must be a string`);
  }
  return [handle as T];
}

export const fileSystemContract = {
  addRoot: rawChannel<InvokeArgs<'addRoot'>, InvokeResult<'addRoot'>>({
    channel: DESKTOP_IPC_CHANNELS.files.addRoot,
    parseArgs: (raw) => parseNoArguments(raw, 'file system addRoot'),
    roles: ['visible-ui'],
  }),
  addRootByPath: rawChannel<InvokeArgs<'addRootByPath'>, InvokeResult<'addRootByPath'>>({
    channel: DESKTOP_IPC_CHANNELS.files.addRootByPath,
    parseArgs: (raw) => parseString(raw, 'file system addRootByPath'),
    roles: ['visible-ui'],
  }),
  exists: rawChannel<InvokeArgs<'exists'>, InvokeResult<'exists'>>({
    channel: DESKTOP_IPC_CHANNELS.files.exists,
    parseArgs: (raw) => parseString(raw, 'file system exists'),
    roles: ['visible-ui'],
  }),
  listRecentRoots: rawChannel<InvokeArgs<'listRecentRoots'>, InvokeResult<'listRecentRoots'>>({
    channel: DESKTOP_IPC_CHANNELS.files.listRecentRoots,
    parseArgs: (raw) => parseNoArguments(raw, 'file system listRecentRoots'),
    roles: ['visible-ui'],
  }),
  readDirectory: rawChannel<InvokeArgs<'readDirectory'>, InvokeResult<'readDirectory'>>({
    channel: DESKTOP_IPC_CHANNELS.files.readDirectory,
    parseArgs: (raw) =>
      parseHandle<InvokeArgs<'readDirectory'>[0]>(raw, 'file system readDirectory'),
    roles: ['visible-ui'],
  }),
  readFile: rawChannel<InvokeArgs<'readFile'>, FileReadWireResult>({
    channel: DESKTOP_IPC_CHANNELS.files.readFile,
    parseArgs: (raw) => parseHandle<InvokeArgs<'readFile'>[0]>(raw, 'file system readFile'),
    roles: ['visible-ui'],
  }),
  readFileByAbsolutePath: rawChannel<InvokeArgs<'readFileByAbsolutePath'>, FileReadWireResult>({
    channel: DESKTOP_IPC_CHANNELS.files.readFileByAbsolutePath,
    parseArgs: (raw) => {
      assertArgCount(raw, 3, 'file system readFileByAbsolutePath');
      // The durable root registry owns the semantic/type denial and its
      // bounded audit record. Preserve that path rather than rejecting here.
      return raw as unknown as InvokeArgs<'readFileByAbsolutePath'>;
    },
    roles: ['visible-ui'],
  }),
  readFileByPath: rawChannel<InvokeArgs<'readFileByPath'>, FileReadWireResult>({
    channel: DESKTOP_IPC_CHANNELS.files.readFileByPath,
    parseArgs: (raw) => parseString(raw, 'file system readFileByPath'),
    roles: ['visible-ui'],
  }),
  removeRoot: rawChannel<InvokeArgs<'removeRoot'>, InvokeResult<'removeRoot'>>({
    channel: DESKTOP_IPC_CHANNELS.files.removeRoot,
    parseArgs: (raw) => parseString(raw, 'file system removeRoot'),
    roles: ['visible-ui'],
  }),
  requestDirectoryAccess: rawChannel<
    InvokeArgs<'requestDirectoryAccess'>,
    InvokeResult<'requestDirectoryAccess'>
  >({
    channel: DESKTOP_IPC_CHANNELS.files.requestDirectoryAccess,
    parseArgs: (raw) => parseNoArguments(raw, 'file system requestDirectoryAccess'),
    roles: ['visible-ui'],
  }),
  restoreLastFolder: rawChannel<InvokeArgs<'restoreLastFolder'>, InvokeResult<'restoreLastFolder'>>(
    {
      channel: DESKTOP_IPC_CHANNELS.files.restoreLastFolder,
      parseArgs: (raw) => parseNoArguments(raw, 'file system restoreLastFolder'),
      roles: ['visible-ui'],
    }
  ),
  restoreRoots: rawChannel<InvokeArgs<'restoreRoots'>, InvokeResult<'restoreRoots'>>({
    channel: DESKTOP_IPC_CHANNELS.files.restoreRoots,
    parseArgs: (raw) => parseNoArguments(raw, 'file system restoreRoots'),
    roles: ['visible-ui'],
  }),
  saveLastFolder: rawChannel<InvokeArgs<'saveLastFolder'>, InvokeResult<'saveLastFolder'>>({
    channel: DESKTOP_IPC_CHANNELS.files.saveLastFolder,
    parseArgs: (raw) => parseString(raw, 'file system saveLastFolder'),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export const fileSystemWatchContract = {
  getWatcherTelemetry: rawChannel<
    InvokeArgs<'getWatcherTelemetry'>,
    InvokeResult<'getWatcherTelemetry'>
  >({
    channel: DESKTOP_IPC_CHANNELS.files.watchTelemetry,
    parseArgs: (raw) => parseNoArguments(raw, 'file system getWatcherTelemetry'),
    roles: ['visible-ui'],
  }),
  onWatchEvent: pushEvent<Parameters<Parameters<ElectronFileSystemAPI['onWatchEvent']>[0]>[0]>({
    channel: DESKTOP_IPC_CHANNELS.files.watchEvent,
  }),
  onWatchHealth: pushEvent<Parameters<Parameters<ElectronFileSystemAPI['onWatchHealth']>[0]>[0]>({
    channel: DESKTOP_IPC_CHANNELS.files.watchHealth,
  }),
  retryWatch: rawChannel<InvokeArgs<'retryWatch'>, InvokeResult<'retryWatch'>>({
    channel: DESKTOP_IPC_CHANNELS.files.watchRetry,
    parseArgs: (raw) => parseString(raw, 'file system retryWatch'),
    roles: ['visible-ui'],
  }),
  unwatchDirectory: rawChannel<InvokeArgs<'unwatchDirectory'>, InvokeResult<'unwatchDirectory'>>({
    channel: DESKTOP_IPC_CHANNELS.files.unwatch,
    parseArgs: (raw) => parseString(raw, 'file system unwatchDirectory'),
    roles: ['visible-ui'],
  }),
  watchDirectory: rawChannel<InvokeArgs<'watchDirectory'>, InvokeResult<'watchDirectory'>>({
    channel: DESKTOP_IPC_CHANNELS.files.watch,
    parseArgs: (raw) =>
      parseHandle<InvokeArgs<'watchDirectory'>[0]>(raw, 'file system watchDirectory'),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

type GeneratedFileSystemBridge = Bridge<typeof fileSystemContract> &
  Bridge<typeof fileSystemWatchContract>;
type AdaptedFileSystemBridge = Omit<GeneratedFileSystemBridge, ReadMethod> &
  Pick<ElectronFileSystemAPI, ReadMethod>;

export type FileSystemBridgeDerivationProof = AssertTrue<
  [AdaptedFileSystemBridge] extends [ElectronFileSystemAPI]
    ? [ElectronFileSystemAPI] extends [AdaptedFileSystemBridge]
      ? true
      : false
    : false
>;
