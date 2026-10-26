/** Pure contracts for desktop persisted storage and preferences. */
import type { StorageAdapter } from '@brainstrike/storage';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  parseNoArgs,
  rawChannel,
} from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';

function parseExactNoArgs(subject: string): (raw: readonly unknown[]) => [] {
  return (raw) => {
    assertArgCount(raw, 0, subject);
    return parseNoArgs();
  };
}

function parseExactString(subject: string): (raw: readonly unknown[]) => [value: string] {
  return (raw) => {
    assertArgCount(raw, 1, subject);
    if (typeof raw[0] !== 'string') {
      throw new TypeError(`${subject} requires a string argument.`);
    }
    return [raw[0]];
  };
}

function parseExactStringPair(
  subject: string
): (raw: readonly unknown[]) => [first: string, second: string] {
  return (raw) => {
    assertArgCount(raw, 2, subject);
    if (typeof raw[0] !== 'string' || typeof raw[1] !== 'string') {
      throw new TypeError(`${subject} requires two string arguments.`);
    }
    return [raw[0], raw[1]];
  };
}

export const storageContract = {
  clear: rawChannel<[], void>({
    channel: DESKTOP_IPC_CHANNELS.storage.clear,
    parseArgs: parseExactNoArgs('storage clear'),
  }),
  getAllKeys: rawChannel<[], string[]>({
    channel: DESKTOP_IPC_CHANNELS.storage.getAllKeys,
    parseArgs: parseExactNoArgs('storage getAllKeys'),
  }),
  getItem: rawChannel<[key: string], string | null>({
    channel: DESKTOP_IPC_CHANNELS.storage.getItem,
    parseArgs: parseExactString('storage getItem'),
  }),
  removeItem: rawChannel<[key: string], void>({
    channel: DESKTOP_IPC_CHANNELS.storage.removeItem,
    parseArgs: parseExactString('storage removeItem'),
  }),
  setItem: rawChannel<[key: string, value: string], void>({
    channel: DESKTOP_IPC_CHANNELS.storage.setItem,
    parseArgs: parseExactStringPair('storage setItem'),
  }),
} as const satisfies Contract;

export const settingsContract = {
  clearAll: rawChannel<[], { message?: string; success: boolean }>({
    channel: DESKTOP_IPC_CHANNELS.preferences.settingsClearAll,
    parseArgs: parseExactNoArgs('settings clearAll'),
  }),
} as const satisfies Contract;

/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type StorageBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof storageContract, StorageAdapter>
>;
