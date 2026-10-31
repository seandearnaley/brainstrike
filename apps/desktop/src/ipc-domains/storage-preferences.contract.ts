/** Pure contracts for desktop persisted storage and preferences. */
import type { StorageAdapter } from '@brainstrike/storage';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  rawChannel,
} from '../platform/ipc-contract';

export const storageContract = {
  getAllKeys: rawChannel<[], string[]>({
    channel: DESKTOP_IPC_CHANNELS.storage.getAllKeys,
  }),
  getItem: rawChannel<[key: string], string | null>({
    channel: DESKTOP_IPC_CHANNELS.storage.getItem,
  }),
  removeItem: rawChannel<[key: string], void>({
    channel: DESKTOP_IPC_CHANNELS.storage.removeItem,
  }),
  setItem: rawChannel<[key: string, value: string], void>({
    channel: DESKTOP_IPC_CHANNELS.storage.setItem,
  }),
} as const satisfies Contract;

/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type StorageBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof storageContract, StorageAdapter>
>;
