/** Pure contract for the desktop Changes bridge. */
import type {
  ChangesBridge,
  RewindApplyPayload,
  RewindFinalizePayload,
  RewindPreviewPayload,
  RewindRedoPayload,
} from '@brainstrike/app-shell/changes/availability';
import type { Changeset } from '@brainstrike/types';
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
  hasOwn,
  optionalBoolean,
  parseRecord,
  requireStringType,
} from './contract-args';

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

interface RewindPayloadByOperation {
  readonly applyRewind: RewindApplyPayload;
  readonly finalizeRewinds: RewindFinalizePayload;
  readonly redoRewind: RewindRedoPayload;
  readonly rewindPreview: RewindPreviewPayload;
}

function parsePayload<K extends keyof RewindPayloadByOperation>(
  operation: K,
  parse: (record: Readonly<Record<string, unknown>>) => RewindPayloadByOperation[K]
): (raw: readonly unknown[]) => [payload: RewindPayloadByOperation[K]] {
  return (raw) => {
    assertArgCount(raw, 1, `changes ${operation}`);
    return [parse(parseRecord(raw[0], `changes ${operation} payload`))];
  };
}

export const changesContract = {
  applyRewind: rawChannel<InvokeArgs<'applyRewind'>, InvokeResult<'applyRewind'>>({
    channel: DESKTOP_IPC_CHANNELS.changes.applyRewind,
    parseArgs: parsePayload('applyRewind', (record) => {
      assertSupportedKeys(
        record,
        ['acknowledgeConflicts', 'messageId', 'mode', 'threadId'],
        'changes applyRewind'
      );
      const acknowledgeConflicts = optionalBoolean(
        record,
        'acknowledgeConflicts',
        'changes applyRewind'
      );
      const messageId = requireStringType(record, 'messageId', 'changes applyRewind');
      const mode = record['mode'];
      if (mode !== 'conversation-only' && mode !== 'conversation-and-files') {
        throw new Error(
          'changes applyRewind mode must be "conversation-only" or "conversation-and-files"'
        );
      }
      const threadId = requireStringType(record, 'threadId', 'changes applyRewind');
      return acknowledgeConflicts === undefined
        ? { messageId, mode, threadId }
        : { acknowledgeConflicts, messageId, mode, threadId };
    }),
    roles: ['visible-ui'],
  }),
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
  finalizeRewinds: rawChannel<InvokeArgs<'finalizeRewinds'>, InvokeResult<'finalizeRewinds'>>({
    channel: DESKTOP_IPC_CHANNELS.changes.finalizeRewinds,
    parseArgs: parsePayload('finalizeRewinds', (record) => {
      assertSupportedKeys(record, ['threadId'], 'changes finalizeRewinds');
      return { threadId: requireStringType(record, 'threadId', 'changes finalizeRewinds') };
    }),
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
  redoRewind: rawChannel<InvokeArgs<'redoRewind'>, InvokeResult<'redoRewind'>>({
    channel: DESKTOP_IPC_CHANNELS.changes.redoRewind,
    parseArgs: parsePayload('redoRewind', (record) => {
      assertSupportedKeys(record, ['acknowledgeConflicts', 'rewindId'], 'changes redoRewind');
      const acknowledgeConflicts = optionalBoolean(
        record,
        'acknowledgeConflicts',
        'changes redoRewind'
      );
      const rewindId = requireStringType(record, 'rewindId', 'changes redoRewind');
      return acknowledgeConflicts === undefined ? { rewindId } : { acknowledgeConflicts, rewindId };
    }),
    roles: ['visible-ui'],
  }),
  resolveView: rawChannel<InvokeArgs<'resolveView'>, InvokeResult<'resolveView'>>({
    channel: DESKTOP_IPC_CHANNELS.changes.resolveView,
    parseArgs: parseRootAndChangeset('resolveView'),
    roles: ['visible-ui'],
  }),
  rewindPreview: rawChannel<InvokeArgs<'rewindPreview'>, InvokeResult<'rewindPreview'>>({
    channel: DESKTOP_IPC_CHANNELS.changes.rewindPreview,
    parseArgs: parsePayload('rewindPreview', (record) => {
      assertSupportedKeys(record, ['messageId', 'runId', 'threadId'], 'changes rewindPreview');
      const threadId = requireStringType(record, 'threadId', 'changes rewindPreview');
      const hasMessageId = hasOwn(record, 'messageId');
      const hasRunId = hasOwn(record, 'runId');
      if (hasMessageId === hasRunId) {
        throw new Error('changes rewindPreview requires exactly one of messageId or runId');
      }
      return hasMessageId
        ? { messageId: requireStringType(record, 'messageId', 'changes rewindPreview'), threadId }
        : { runId: requireStringType(record, 'runId', 'changes rewindPreview'), threadId };
    }),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export type ChangesBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof changesContract, ChangesBridge>
>;
