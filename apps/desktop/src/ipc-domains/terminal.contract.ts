/** Pure contract for the renderer-owned desktop terminal bridge. */
import type { TerminalBridge } from '@brainstrike/app-shell/terminal-panel/availability';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  pushEvent,
  rawChannel,
} from '../platform/ipc-contract';
import {
  exactSupportedKeys,
  optionalFiniteNumber,
  optionalStringType,
  parseSingleRecordArg,
  requireFiniteNumber,
  requireStringType,
} from './contract-args';

type InvokeArgs<K extends keyof TerminalBridge> = Parameters<TerminalBridge[K]>;
type InvokeResult<K extends keyof TerminalBridge> = Awaited<ReturnType<TerminalBridge[K]>>;

const TERMINAL_CREATE_KEYS = exactSupportedKeys<InvokeArgs<'create'>[0]>()([
  'cols',
  'cwd',
  'rootId',
  'rows',
]);
const TERMINAL_DESTROY_KEYS = exactSupportedKeys<InvokeArgs<'destroy'>[0]>()(['terminalId']);
const TERMINAL_RESIZE_KEYS = exactSupportedKeys<InvokeArgs<'resize'>[0]>()([
  'cols',
  'rows',
  'terminalId',
]);
const TERMINAL_WRITE_KEYS = exactSupportedKeys<InvokeArgs<'write'>[0]>()(['data', 'terminalId']);

export const terminalContract = {
  create: rawChannel<InvokeArgs<'create'>, InvokeResult<'create'>>({
    channel: DESKTOP_IPC_CHANNELS.terminal.create,
    parseArgs: parseSingleRecordArg('terminal create', TERMINAL_CREATE_KEYS, (record) => {
      const cols = optionalFiniteNumber(record, 'cols', 'terminal create');
      const cwd = optionalStringType(record, 'cwd', 'terminal create');
      const rootId = requireStringType(record, 'rootId', 'terminal create');
      const rows = optionalFiniteNumber(record, 'rows', 'terminal create');
      return {
        ...(cols === undefined ? {} : { cols }),
        ...(cwd === undefined ? {} : { cwd }),
        rootId,
        ...(rows === undefined ? {} : { rows }),
      };
    }),
    roles: ['visible-ui'],
  }),
  destroy: rawChannel<InvokeArgs<'destroy'>, InvokeResult<'destroy'>>({
    channel: DESKTOP_IPC_CHANNELS.terminal.destroy,
    parseArgs: parseSingleRecordArg('terminal destroy', TERMINAL_DESTROY_KEYS, (record) => ({
      terminalId: requireStringType(record, 'terminalId', 'terminal destroy'),
    })),
    roles: ['visible-ui'],
  }),
  onData: pushEvent<Parameters<Parameters<TerminalBridge['onData']>[0]>[0]>({
    channel: DESKTOP_IPC_CHANNELS.terminal.data,
  }),
  onExit: pushEvent<Parameters<Parameters<TerminalBridge['onExit']>[0]>[0]>({
    channel: DESKTOP_IPC_CHANNELS.terminal.exit,
  }),
  resize: rawChannel<InvokeArgs<'resize'>, InvokeResult<'resize'>>({
    channel: DESKTOP_IPC_CHANNELS.terminal.resize,
    parseArgs: parseSingleRecordArg('terminal resize', TERMINAL_RESIZE_KEYS, (record) => ({
      cols: requireFiniteNumber(record, 'cols', 'terminal resize'),
      rows: requireFiniteNumber(record, 'rows', 'terminal resize'),
      terminalId: requireStringType(record, 'terminalId', 'terminal resize'),
    })),
    roles: ['visible-ui'],
  }),
  write: rawChannel<InvokeArgs<'write'>, InvokeResult<'write'>>({
    channel: DESKTOP_IPC_CHANNELS.terminal.write,
    parseArgs: parseSingleRecordArg('terminal write', TERMINAL_WRITE_KEYS, (record) => ({
      data: requireStringType(record, 'data', 'terminal write'),
      terminalId: requireStringType(record, 'terminalId', 'terminal write'),
    })),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export type TerminalBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof terminalContract, TerminalBridge>
>;
