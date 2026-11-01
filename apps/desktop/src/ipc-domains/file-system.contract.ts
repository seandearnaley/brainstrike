/**
 * Pure contracts for the visible-UI desktop file-system bridge. The agent host owns the
 * workspace's folders (ADR-0029 stage 4); Main keeps only the index's root-data deletion.
 */
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
  deleteRootData: channel<InvokeArgs<'deleteRootData'>, InvokeResult<'deleteRootData'>>({
    channel: DESKTOP_IPC_CHANNELS.files.deleteRootData,
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
