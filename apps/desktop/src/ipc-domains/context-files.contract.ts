/**
 * `contextFiles` IPC contract (BST-1648): the Settings → Workspace
 * Instructions per-root scan (`window.contextFiles`). Pinned equal to
 * `ContextFilesBridge` in @brainstrike/assistant-contract below. PURE —
 * bundled into the preload and imported by main.
 */
import type {
  ContextFilesBridge,
  WorkspaceContextFileStatus,
} from '@brainstrike/assistant-contract/context-files-bridge';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  channel,
} from '../platform/ipc-contract';

export const contextFilesContract = {
  scan: channel<[], WorkspaceContextFileStatus[]>({
    channel: DESKTOP_IPC_CHANNELS.contextFiles.scan,
  }),
} satisfies Contract;

/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type ContextFilesBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof contextFilesContract, ContextFilesBridge>
>;
