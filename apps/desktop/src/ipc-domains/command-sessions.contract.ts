/** Pure contract for the main-owned command-session inventory bridge. */
import type {
  CommandSessionBridge,
  CommandSessionIdentityParams,
  CommandSessionInfo,
  CommandSessionReadPage,
  CommandSessionResult,
} from '@brainstrike/app-shell/terminal-panel/availability';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  rawChannel,
} from '../platform/ipc-contract';
import {
  assertArgCount,
  assertSupportedKeys,
  parseRecord,
  requireStringType,
} from './contract-args';

type ParamsRecord = Readonly<Record<string, unknown>>;

function parseParams<T>(
  operation: string,
  supported: readonly string[],
  parse: (record: ParamsRecord) => T
): (raw: readonly unknown[]) => [params: T] {
  const subject = `command sessions ${operation}`;
  return (raw) => {
    assertArgCount(raw, 1, subject);
    const record = parseRecord(raw[0], `${subject} params`);
    assertSupportedKeys(record, supported, subject);
    return [parse(record)];
  };
}

function parseIdentity(
  record: ParamsRecord,
  operation: string
): {
  rootId: string;
  sessionId: string;
} {
  const subject = `command sessions ${operation}`;
  return {
    rootId: requireStringType(record, 'rootId', subject),
    sessionId: requireStringType(record, 'sessionId', subject),
  };
}

export const commandSessionsContract = {
  list: rawChannel<
    [params: { readonly rootId: string }],
    CommandSessionResult<{
      readonly rootId: string;
      readonly sessions: readonly CommandSessionInfo[];
    }>
  >({
    channel: DESKTOP_IPC_CHANNELS.commandSessions.list,
    parseArgs: parseParams('list', ['rootId'], (record) => ({
      rootId: requireStringType(record, 'rootId', 'command sessions list'),
    })),
    roles: ['visible-ui'],
  }),
  read: rawChannel<
    [params: CommandSessionIdentityParams & { readonly cursor?: number }],
    CommandSessionResult<CommandSessionReadPage>
  >({
    channel: DESKTOP_IPC_CHANNELS.commandSessions.read,
    parseArgs: parseParams('read', ['cursor', 'rootId', 'sessionId'], (record) => {
      const identity = parseIdentity(record, 'read');
      const cursor = record['cursor'];
      if (cursor !== undefined && (typeof cursor !== 'number' || !Number.isFinite(cursor))) {
        throw new Error('command sessions read cursor must be a finite number when present');
      }
      return cursor === undefined ? identity : { ...identity, cursor };
    }),
    roles: ['visible-ui'],
  }),
  remove: rawChannel<[params: CommandSessionIdentityParams], CommandSessionResult>({
    channel: DESKTOP_IPC_CHANNELS.commandSessions.remove,
    parseArgs: parseParams('remove', ['rootId', 'sessionId'], (record) =>
      parseIdentity(record, 'remove')
    ),
    roles: ['visible-ui'],
  }),
  stop: rawChannel<[params: CommandSessionIdentityParams], CommandSessionResult>({
    channel: DESKTOP_IPC_CHANNELS.commandSessions.stop,
    parseArgs: parseParams('stop', ['rootId', 'sessionId'], (record) =>
      parseIdentity(record, 'stop')
    ),
    roles: ['visible-ui'],
  }),
  write: rawChannel<
    [params: CommandSessionIdentityParams & { readonly data: string }],
    CommandSessionResult
  >({
    channel: DESKTOP_IPC_CHANNELS.commandSessions.write,
    parseArgs: parseParams('write', ['data', 'rootId', 'sessionId'], (record) => ({
      ...parseIdentity(record, 'write'),
      data: requireStringType(record, 'data', 'command sessions write'),
    })),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export type CommandSessionsBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof commandSessionsContract, CommandSessionBridge>
>;
