/**
 * Pure contract for the desktop's two native folder pickers. The OS dialog belongs
 * to Main; every other folder, Explorer read and watcher lives in the agent host
 * (ADR-0029 stage 4). PURE: bundled into the preload and imported by Main.
 */
import type { DirectoryHandle, RootDescriptor } from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  channel,
  parseNoArgs,
} from '../platform/ipc-contract';

/** The renderer's view of the pickers: each resolves the chosen folder or rejects. */
export interface DesktopFolderPicker {
  /** Pick a folder and register it as a workspace root. */
  addRoot(): Promise<RootDescriptor>;
  /** Pick a folder; Main records it as a root and as the last folder. */
  requestDirectoryAccess(): Promise<DirectoryHandle>;
}

export const folderPickerContract = {
  addRoot: channel<[], RootDescriptor>({
    channel: DESKTOP_IPC_CHANNELS.files.addRoot,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
  requestDirectoryAccess: channel<[], DirectoryHandle>({
    channel: DESKTOP_IPC_CHANNELS.files.requestDirectoryAccess,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type FolderPickerBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof folderPickerContract, DesktopFolderPicker>
>;
