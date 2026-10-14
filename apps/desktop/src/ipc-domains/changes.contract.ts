/** Pure contract for the desktop Changes bridge. */
import type { ChangesBridge } from '@brainstrike/app-shell/changes/availability';
import type { Changeset } from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  pushEvent,
  rawChannel,
} from '../platform/ipc-contract';
import { assertArgCount, assertSupportedKeys, parseRecord } from './contract-args';

type InvokeArgs<K extends keyof ChangesBridge> = Parameters<ChangesBridge[K]>;
type InvokeResult<K extends keyof ChangesBridge> = Awaited<ReturnType<ChangesBridge[K]>>;

function parseChangeset(value: unknown, operation: string): Changeset {
  const record = parseRecord(value, `changes ${operation} changeset`);
  if (
    record['kind'] !== 'agent-run' &&
    record['kind'] !== 'run-range' &&
    record['kind'] !== 'git-scope'
  ) {
    throw new Error(
      `changes ${operation} changeset kind must be "agent-run", "run-range", or "git-scope"`
    );
  }
  return record as unknown as Changeset;
}

function parseRootAndChangeset(
  operation: 'resolveView'
): (raw: readonly unknown[]) => InvokeArgs<'resolveView'> {
  return (raw) => {
    assertArgCount(raw, 2, `changes ${operation}`);
    if (typeof raw[0] !== 'string') {
      throw new Error(`changes ${operation} rootId must be a string`);
    }
    return [raw[0], parseChangeset(raw[1], operation)];
  };
}

export const changesContract = {
  fileDiff: rawChannel<InvokeArgs<'fileDiff'>, InvokeResult<'fileDiff'>>({
    channel: DESKTOP_IPC_CHANNELS.changes.fileDiff,
    parseArgs: (raw) => {
      assertArgCount(raw, 3, 'changes fileDiff');
      if (typeof raw[0] !== 'string') {
        throw new Error('changes fileDiff rootId must be a string');
      }
      const changeset = parseChangeset(raw[1], 'fileDiff');
      if (typeof raw[2] !== 'string') {
        throw new Error('changes fileDiff requires a string path');
      }
      return [raw[0], changeset, raw[2]];
    },
    roles: ['visible-ui'],
  }),
  inventory: rawChannel<InvokeArgs<'inventory'>, InvokeResult<'inventory'>>({
    channel: DESKTOP_IPC_CHANNELS.changes.inventory,
    parseArgs: (raw) => {
      if (raw.length > 1) {
        throw new Error('changes inventory requires zero or one argument');
      }
      const record =
        raw.length === 0 || raw[0] === undefined
          ? {}
          : parseRecord(raw[0], 'changes inventory options');
      assertSupportedKeys(record, ['maxAgeMs'], 'changes inventory');
      const maxAgeMs = record['maxAgeMs'];
      if (maxAgeMs !== undefined && typeof maxAgeMs !== 'number') {
        throw new Error('changes inventory maxAgeMs must be a number when present');
      }
      return [maxAgeMs === undefined ? {} : { maxAgeMs: maxAgeMs as number }];
    },
    roles: ['visible-ui'],
  }),
  onInvalidated: pushEvent<Parameters<Parameters<ChangesBridge['onInvalidated']>[0]>[0]>({
    channel: DESKTOP_IPC_CHANNELS.changes.invalidated,
  }),
  resolveView: rawChannel<InvokeArgs<'resolveView'>, InvokeResult<'resolveView'>>({
    channel: DESKTOP_IPC_CHANNELS.changes.resolveView,
    parseArgs: parseRootAndChangeset('resolveView'),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export type ChangesBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof changesContract, ChangesBridge>
>;
