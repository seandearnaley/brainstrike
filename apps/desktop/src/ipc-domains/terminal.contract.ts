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
  assertArgCount,
  assertSupportedKeys,
  optionalStringType,
  parseRecord,
  requireStringType,
} from './contract-args';

type InvokeArgs<K extends keyof TerminalBridge> = Parameters<TerminalBridge[K]>;
type InvokeResult<K extends keyof TerminalBridge> = Awaited<ReturnType<TerminalBridge[K]>>;

function optionalFiniteNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
  subject: string
): number | undefined {
  const value = record[key];
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${subject} ${key} must be a finite number when present`);
  }
  return value as number | undefined;
}

function requireFiniteNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
  subject: string
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${subject} ${key} must be a finite number`);
  }
  return value;
}

function parseParams<T>(
  subject: string,
  supported: readonly string[],
  parse: (record: Readonly<Record<string, unknown>>) => T
): (raw: readonly unknown[]) => [params: T] {
  return (raw) => {
    assertArgCount(raw, 1, subject);
    const record = parseRecord(raw[0], `${subject} params`);
    assertSupportedKeys(record, supported, subject);
    return [parse(record)];
  };
}

export const terminalContract = {
  create: rawChannel<InvokeArgs<'create'>, InvokeResult<'create'>>({
    channel: DESKTOP_IPC_CHANNELS.terminal.create,
    parseArgs: parseParams('terminal create', ['cols', 'cwd', 'rootId', 'rows'], (record) => {
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
    parseArgs: parseParams('terminal destroy', ['terminalId'], (record) => ({
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
    parseArgs: parseParams('terminal resize', ['cols', 'rows', 'terminalId'], (record) => ({
      cols: requireFiniteNumber(record, 'cols', 'terminal resize'),
      rows: requireFiniteNumber(record, 'rows', 'terminal resize'),
      terminalId: requireStringType(record, 'terminalId', 'terminal resize'),
    })),
    roles: ['visible-ui'],
  }),
  write: rawChannel<InvokeArgs<'write'>, InvokeResult<'write'>>({
    channel: DESKTOP_IPC_CHANNELS.terminal.write,
    parseArgs: parseParams('terminal write', ['data', 'terminalId'], (record) => ({
      data: requireStringType(record, 'data', 'terminal write'),
      terminalId: requireStringType(record, 'terminalId', 'terminal write'),
    })),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export type TerminalBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof terminalContract, TerminalBridge>
>;
