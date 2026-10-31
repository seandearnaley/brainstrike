/** Pure contracts for the visible-UI desktop file-system bridge. */
import type { FileReadErrorPayload } from '../file-read-errors';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type Bridge,
  type Contract,
  channel,
  pushEvent,
  rawChannel,
  type TransportBridge,
} from '../platform/ipc-contract';
import type { DesktopFileSystemBridge } from '../types/desktop-electron-api';

type ReadMethod = 'readFile' | 'readFileByAbsolutePath' | 'readFileByPath';
type InvokeArgs<K extends keyof DesktopFileSystemBridge> = Parameters<DesktopFileSystemBridge[K]>;
type InvokeResult<K extends keyof DesktopFileSystemBridge> = Awaited<
  ReturnType<DesktopFileSystemBridge[K]>
>;
type FileReadWireResult = string | FileReadErrorPayload;

export const fileSystemContract = {
  addRoot: channel<InvokeArgs<'addRoot'>, InvokeResult<'addRoot'>>({
    channel: DESKTOP_IPC_CHANNELS.files.addRoot,
  }),
  addRootByPath: channel<InvokeArgs<'addRootByPath'>, InvokeResult<'addRootByPath'>>({
    channel: DESKTOP_IPC_CHANNELS.files.addRootByPath,
  }),
  deleteRootData: channel<InvokeArgs<'deleteRootData'>, InvokeResult<'deleteRootData'>>({
    channel: DESKTOP_IPC_CHANNELS.files.deleteRootData,
  }),
  exists: channel<InvokeArgs<'exists'>, InvokeResult<'exists'>>({
    channel: DESKTOP_IPC_CHANNELS.files.exists,
  }),
  listRecentRoots: channel<InvokeArgs<'listRecentRoots'>, InvokeResult<'listRecentRoots'>>({
    channel: DESKTOP_IPC_CHANNELS.files.listRecentRoots,
  }),
  readDirectory: channel<InvokeArgs<'readDirectory'>, InvokeResult<'readDirectory'>>({
    channel: DESKTOP_IPC_CHANNELS.files.readDirectory,
  }),
  readFile: channel<InvokeArgs<'readFile'>, FileReadWireResult>({
    channel: DESKTOP_IPC_CHANNELS.files.readFile,
  }),
  readFileByAbsolutePath: channel<InvokeArgs<'readFileByAbsolutePath'>, FileReadWireResult>({
    channel: DESKTOP_IPC_CHANNELS.files.readFileByAbsolutePath,
  }),
  readFileByPath: channel<InvokeArgs<'readFileByPath'>, FileReadWireResult>({
    channel: DESKTOP_IPC_CHANNELS.files.readFileByPath,
  }),
  removeRoot: channel<InvokeArgs<'removeRoot'>, InvokeResult<'removeRoot'>>({
    channel: DESKTOP_IPC_CHANNELS.files.removeRoot,
  }),
  requestDirectoryAccess: channel<
    InvokeArgs<'requestDirectoryAccess'>,
    InvokeResult<'requestDirectoryAccess'>
  >({
    channel: DESKTOP_IPC_CHANNELS.files.requestDirectoryAccess,
  }),
  restoreLastFolder: channel<InvokeArgs<'restoreLastFolder'>, InvokeResult<'restoreLastFolder'>>({
    channel: DESKTOP_IPC_CHANNELS.files.restoreLastFolder,
  }),
  restoreRoots: channel<InvokeArgs<'restoreRoots'>, InvokeResult<'restoreRoots'>>({
    channel: DESKTOP_IPC_CHANNELS.files.restoreRoots,
  }),
  saveLastFolder: channel<InvokeArgs<'saveLastFolder'>, InvokeResult<'saveLastFolder'>>({
    channel: DESKTOP_IPC_CHANNELS.files.saveLastFolder,
  }),
} as const satisfies Contract;

export const fileSystemWatchContract = {
  getWatcherTelemetry: rawChannel<
    InvokeArgs<'getWatcherTelemetry'>,
    InvokeResult<'getWatcherTelemetry'>
  >({
    channel: DESKTOP_IPC_CHANNELS.files.watchTelemetry,
  }),
  onWatchEvent: pushEvent<Parameters<Parameters<DesktopFileSystemBridge['onWatchEvent']>[0]>[0]>({
    channel: DESKTOP_IPC_CHANNELS.files.watchEvent,
  }),
  onWatchHealth: pushEvent<Parameters<Parameters<DesktopFileSystemBridge['onWatchHealth']>[0]>[0]>({
    channel: DESKTOP_IPC_CHANNELS.files.watchHealth,
  }),
  retryWatch: rawChannel<InvokeArgs<'retryWatch'>, InvokeResult<'retryWatch'>>({
    channel: DESKTOP_IPC_CHANNELS.files.watchRetry,
  }),
  unwatchDirectory: rawChannel<InvokeArgs<'unwatchDirectory'>, InvokeResult<'unwatchDirectory'>>({
    channel: DESKTOP_IPC_CHANNELS.files.unwatch,
  }),
  watchDirectory: rawChannel<InvokeArgs<'watchDirectory'>, InvokeResult<'watchDirectory'>>({
    channel: DESKTOP_IPC_CHANNELS.files.watch,
  }),
} as const satisfies Contract;

type GeneratedFileSystemBridge = Bridge<typeof fileSystemContract> &
  Bridge<typeof fileSystemWatchContract>;
type AdaptedFileSystemBridge = Omit<GeneratedFileSystemBridge, ReadMethod> &
  Pick<DesktopFileSystemBridge, ReadMethod>;

/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type FileSystemBridgeDerivationProof = AssertTrue<
  [AdaptedFileSystemBridge] extends [DesktopFileSystemBridge]
    ? [DesktopFileSystemBridge] extends [AdaptedFileSystemBridge]
      ? true
      : false
    : false
>;

export type DesktopFileSystemTransport = TransportBridge<typeof fileSystemContract> &
  TransportBridge<typeof fileSystemWatchContract>;
