/** Pure contract for the desktop-native notes vault bridge. */
import type { NotesVaultBridge } from '@brainstrike/notes-vault/desktop-contract';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  pushEvent,
  rawChannel,
} from '../platform/ipc-contract';
import {
  assertArgCount,
  assertSupportedKeys,
  exactSupportedKeys,
  parseRecord,
} from './contract-args';

type InvokeKey = Exclude<keyof NotesVaultBridge, 'onChanged'>;
type InvokeArgs<K extends InvokeKey> = Parameters<NotesVaultBridge[K]>;
type InvokeResult<K extends InvokeKey> = Awaited<ReturnType<NotesVaultBridge[K]>>;

const DELETE_ENTRY_OPTION_KEYS = exactSupportedKeys<InvokeArgs<'deleteEntry'>[1]>()(['recursive']);

function parseNoArgs(subject: string): (raw: readonly unknown[]) => [] {
  return (raw) => {
    assertArgCount(raw, 0, subject);
    return [];
  };
}

function parseString(value: unknown, subject: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${subject} must be a string`);
  }
  return value;
}

function parseOneString(subject: string): (raw: readonly unknown[]) => [value: string] {
  return (raw) => {
    assertArgCount(raw, 1, subject);
    return [parseString(raw[0], subject)];
  };
}

function parseTwoStrings(
  subject: string
): (raw: readonly unknown[]) => [first: string, second: string] {
  return (raw) => {
    assertArgCount(raw, 2, subject);
    return [
      parseString(raw[0], `${subject} first argument`),
      parseString(raw[1], `${subject} second argument`),
    ];
  };
}

export const notesVaultContract = {
  createDirectory: rawChannel<InvokeArgs<'createDirectory'>, InvokeResult<'createDirectory'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.createDirectory,
    parseArgs: parseOneString('notes vault createDirectory path'),
    roles: ['visible-ui'],
  }),
  deleteEntry: rawChannel<InvokeArgs<'deleteEntry'>, InvokeResult<'deleteEntry'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.deleteEntry,
    parseArgs: (raw) => {
      assertArgCount(raw, 2, 'notes vault deleteEntry');
      const path = parseString(raw[0], 'notes vault deleteEntry path');
      const options = parseRecord(raw[1], 'notes vault deleteEntry options');
      assertSupportedKeys(options, DELETE_ENTRY_OPTION_KEYS, 'notes vault deleteEntry options');
      if (typeof options['recursive'] !== 'boolean') {
        throw new Error('notes vault deleteEntry recursive must be a boolean');
      }
      return [path, { recursive: options['recursive'] }];
    },
    roles: ['visible-ui'],
  }),
  ensureDefaultVault: rawChannel<
    InvokeArgs<'ensureDefaultVault'>,
    InvokeResult<'ensureDefaultVault'>
  >({
    channel: DESKTOP_IPC_CHANNELS.notesVault.ensureDefaultVault,
    parseArgs: parseNoArgs('notes vault ensureDefaultVault'),
    roles: ['visible-ui'],
  }),
  listDirectory: rawChannel<InvokeArgs<'listDirectory'>, InvokeResult<'listDirectory'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.listDirectory,
    parseArgs: parseOneString('notes vault listDirectory path'),
    roles: ['visible-ui'],
  }),
  onChanged: pushEvent<Parameters<Parameters<NotesVaultBridge['onChanged']>[0]>[0]>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.changed,
  }),
  pickDirectory: rawChannel<InvokeArgs<'pickDirectory'>, InvokeResult<'pickDirectory'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.pickDirectory,
    parseArgs: parseNoArgs('notes vault pickDirectory'),
    roles: ['visible-ui'],
  }),
  readFile: rawChannel<InvokeArgs<'readFile'>, InvokeResult<'readFile'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.readFile,
    parseArgs: parseOneString('notes vault readFile path'),
    roles: ['visible-ui'],
  }),
  registerRoot: rawChannel<InvokeArgs<'registerRoot'>, InvokeResult<'registerRoot'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.registerRoot,
    parseArgs: parseOneString('notes vault registerRoot path'),
    roles: ['visible-ui'],
  }),
  rename: rawChannel<InvokeArgs<'rename'>, InvokeResult<'rename'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.rename,
    parseArgs: parseTwoStrings('notes vault rename'),
    roles: ['visible-ui'],
  }),
  statEntry: rawChannel<InvokeArgs<'statEntry'>, InvokeResult<'statEntry'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.statEntry,
    parseArgs: parseOneString('notes vault statEntry path'),
    roles: ['visible-ui'],
  }),
  unwatch: rawChannel<InvokeArgs<'unwatch'>, InvokeResult<'unwatch'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.unwatch,
    parseArgs: parseOneString('notes vault unwatch watchId'),
    roles: ['visible-ui'],
  }),
  watch: rawChannel<InvokeArgs<'watch'>, InvokeResult<'watch'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.watch,
    parseArgs: parseOneString('notes vault watch path'),
    roles: ['visible-ui'],
  }),
  writeFile: rawChannel<InvokeArgs<'writeFile'>, InvokeResult<'writeFile'>>({
    channel: DESKTOP_IPC_CHANNELS.notesVault.writeFile,
    parseArgs: parseTwoStrings('notes vault writeFile'),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export type NotesVaultBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof notesVaultContract, NotesVaultBridge>
>;
