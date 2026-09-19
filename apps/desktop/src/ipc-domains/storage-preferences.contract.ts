/** Pure contracts for desktop persisted storage and layout preferences. */
import type { StorageAdapter } from '@brainstrike/storage';
import type {
  LayoutElectronAPI,
  LayoutLoadResult,
  LayoutPersistenceResult,
  PanelPersistenceState,
} from '@brainstrike/ui';
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

function parsePanelLayout(raw: readonly unknown[]): [state: PanelPersistenceState] {
  assertArgCount(raw, 1, 'layout save');
  // The existing main handler owns the Zod validation and returns a structured
  // LayoutPersistenceResult for invalid state. Preserve that public behavior;
  // the contract only rejects an invalid positional tuple here.
  return [raw[0] as PanelPersistenceState];
}

export const storageContract = {
  clear: rawChannel<[], void>({
    channel: DESKTOP_IPC_CHANNELS.storage.clear,
    parseArgs: parseExactNoArgs('storage clear'),
    roles: ['visible-ui'],
  }),
  getAllKeys: rawChannel<[], string[]>({
    channel: DESKTOP_IPC_CHANNELS.storage.getAllKeys,
    parseArgs: parseExactNoArgs('storage getAllKeys'),
    roles: ['visible-ui'],
  }),
  getItem: rawChannel<[key: string], string | null>({
    channel: DESKTOP_IPC_CHANNELS.storage.getItem,
    parseArgs: parseExactString('storage getItem'),
    roles: ['visible-ui'],
  }),
  removeItem: rawChannel<[key: string], void>({
    channel: DESKTOP_IPC_CHANNELS.storage.removeItem,
    parseArgs: parseExactString('storage removeItem'),
    roles: ['visible-ui'],
  }),
  setItem: rawChannel<[key: string, value: string], void>({
    channel: DESKTOP_IPC_CHANNELS.storage.setItem,
    parseArgs: parseExactStringPair('storage setItem'),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export const layoutContract = {
  loadLayout: rawChannel<[], LayoutLoadResult>({
    channel: DESKTOP_IPC_CHANNELS.preferences.layoutLoad,
    parseArgs: parseExactNoArgs('layout load'),
    roles: ['visible-ui'],
  }),
  saveLayout: rawChannel<[state: PanelPersistenceState], LayoutPersistenceResult>({
    channel: DESKTOP_IPC_CHANNELS.preferences.layoutSave,
    parseArgs: parsePanelLayout,
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export const settingsContract = {
  clearAll: rawChannel<[], { message?: string; success: boolean }>({
    channel: DESKTOP_IPC_CHANNELS.preferences.settingsClearAll,
    parseArgs: parseExactNoArgs('settings clearAll'),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export const vectorPreferencesContract = {
  clear: rawChannel<[], void>({
    channel: DESKTOP_IPC_CHANNELS.vectorPreferences.clear,
    parseArgs: parseExactNoArgs('vector preferences clear'),
    roles: ['embedding-host'],
  }),
  read: rawChannel<[], string | null>({
    channel: DESKTOP_IPC_CHANNELS.vectorPreferences.read,
    parseArgs: parseExactNoArgs('vector preferences read'),
    roles: ['embedding-host'],
  }),
  write: rawChannel<[value: string], void>({
    channel: DESKTOP_IPC_CHANNELS.vectorPreferences.write,
    parseArgs: parseExactString('vector preferences write'),
    roles: ['embedding-host'],
  }),
} as const satisfies Contract;

export type StorageBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof storageContract, StorageAdapter>
>;
export type LayoutBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof layoutContract, LayoutElectronAPI>
>;
