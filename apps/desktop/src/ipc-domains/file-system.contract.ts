/** Pure contracts for the visible-UI desktop file-system bridge. */
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type Bridge,
  type Contract,
  channel,
  type TransportBridge,
} from '../platform/ipc-contract';
import type { DesktopFileSystemBridge } from '../types/desktop-electron-api';

type InvokeArgs<K extends keyof DesktopFileSystemBridge> = Parameters<DesktopFileSystemBridge[K]>;
type InvokeResult<K extends keyof DesktopFileSystemBridge> = Awaited<
  ReturnType<DesktopFileSystemBridge[K]>
>;

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
  listRecentRoots: channel<InvokeArgs<'listRecentRoots'>, InvokeResult<'listRecentRoots'>>({
    channel: DESKTOP_IPC_CHANNELS.files.listRecentRoots,
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

type GeneratedFileSystemBridge = Bridge<typeof fileSystemContract>;

/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type FileSystemBridgeDerivationProof = AssertTrue<
  [GeneratedFileSystemBridge] extends [DesktopFileSystemBridge]
    ? [DesktopFileSystemBridge] extends [GeneratedFileSystemBridge]
      ? true
      : false
    : false
>;

export type DesktopFileSystemTransport = TransportBridge<typeof fileSystemContract>;
