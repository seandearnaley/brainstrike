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
  exactSupportedKeys,
  optionalFiniteNumber,
  type ParamsRecord,
  parseSingleRecordArg,
  requireStringType,
} from './contract-args';

function parseIdentity(
  record: ParamsRecord,
  subject: string
): {
  rootId: string;
  sessionId: string;
} {
  return {
    rootId: requireStringType(record, 'rootId', subject),
    sessionId: requireStringType(record, 'sessionId', subject),
  };
}

type CommandSessionListParams = Parameters<CommandSessionBridge['list']>[0];
type CommandSessionReadParams = Parameters<CommandSessionBridge['read']>[0];
type CommandSessionRemoveParams = Parameters<CommandSessionBridge['remove']>[0];
type CommandSessionStopParams = Parameters<CommandSessionBridge['stop']>[0];
type CommandSessionWriteParams = Parameters<CommandSessionBridge['write']>[0];

const COMMAND_SESSION_LIST_KEYS = exactSupportedKeys<CommandSessionListParams>()(['rootId']);
const COMMAND_SESSION_READ_KEYS = exactSupportedKeys<CommandSessionReadParams>()([
  'cursor',
  'rootId',
  'sessionId',
]);
const COMMAND_SESSION_REMOVE_KEYS = exactSupportedKeys<CommandSessionRemoveParams>()([
  'rootId',
  'sessionId',
]);
const COMMAND_SESSION_STOP_KEYS = exactSupportedKeys<CommandSessionStopParams>()([
  'rootId',
  'sessionId',
]);
const COMMAND_SESSION_WRITE_KEYS = exactSupportedKeys<CommandSessionWriteParams>()([
  'data',
  'rootId',
  'sessionId',
]);

export const commandSessionsContract = {
  list: rawChannel<
    [params: { readonly rootId: string }],
    CommandSessionResult<{
      readonly rootId: string;
      readonly sessions: readonly CommandSessionInfo[];
    }>
  >({
    channel: DESKTOP_IPC_CHANNELS.commandSessions.list,
    parseArgs: parseSingleRecordArg(
      'command sessions list',
      COMMAND_SESSION_LIST_KEYS,
      (record) => ({
        rootId: requireStringType(record, 'rootId', 'command sessions list'),
      })
    ),
    roles: ['visible-ui'],
  }),
  read: rawChannel<
    [params: CommandSessionIdentityParams & { readonly cursor?: number }],
    CommandSessionResult<CommandSessionReadPage>
  >({
    channel: DESKTOP_IPC_CHANNELS.commandSessions.read,
    parseArgs: parseSingleRecordArg(
      'command sessions read',
      COMMAND_SESSION_READ_KEYS,
      (record) => {
        const identity = parseIdentity(record, 'command sessions read');
        const cursor = optionalFiniteNumber(record, 'cursor', 'command sessions read');
        return cursor === undefined ? identity : { ...identity, cursor };
      }
    ),
    roles: ['visible-ui'],
  }),
  remove: rawChannel<[params: CommandSessionIdentityParams], CommandSessionResult>({
    channel: DESKTOP_IPC_CHANNELS.commandSessions.remove,
    parseArgs: parseSingleRecordArg(
      'command sessions remove',
      COMMAND_SESSION_REMOVE_KEYS,
      (record) => parseIdentity(record, 'command sessions remove')
    ),
    roles: ['visible-ui'],
  }),
  stop: rawChannel<[params: CommandSessionIdentityParams], CommandSessionResult>({
    channel: DESKTOP_IPC_CHANNELS.commandSessions.stop,
    parseArgs: parseSingleRecordArg('command sessions stop', COMMAND_SESSION_STOP_KEYS, (record) =>
      parseIdentity(record, 'command sessions stop')
    ),
    roles: ['visible-ui'],
  }),
  write: rawChannel<
    [params: CommandSessionIdentityParams & { readonly data: string }],
    CommandSessionResult
  >({
    channel: DESKTOP_IPC_CHANNELS.commandSessions.write,
    parseArgs: parseSingleRecordArg(
      'command sessions write',
      COMMAND_SESSION_WRITE_KEYS,
      (record) => ({
        ...parseIdentity(record, 'command sessions write'),
        data: requireStringType(record, 'data', 'command sessions write'),
      })
    ),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export type CommandSessionsBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof commandSessionsContract, CommandSessionBridge>
>;
