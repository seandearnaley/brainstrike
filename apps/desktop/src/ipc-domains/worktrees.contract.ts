/** Pure contract for the desktop managed-worktrees bridge. */
import type { WorktreesBridge } from '@brainstrike/app-shell/worktrees/availability';
import type {
  WorktreeAdoptParams,
  WorktreeBranchRequest,
  WorktreeCreateParams,
  WorktreeSettings,
} from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  parseNoArgs,
  rawChannel,
} from '../platform/ipc-contract';
import {
  assertArgCount,
  assertSupportedKeys,
  optionalBoolean,
  optionalStringType,
  type ParamsRecord,
  parseRecord,
  requireStringType,
} from './contract-args';

type InvokeArgs<K extends keyof WorktreesBridge> = Parameters<WorktreesBridge[K]>;
type InvokeResult<K extends keyof WorktreesBridge> = Awaited<ReturnType<WorktreesBridge[K]>>;

function parseOne<K extends keyof WorktreesBridge>(
  operation: K,
  parse: (record: ParamsRecord) => Parameters<WorktreesBridge[K]>[0]
): (raw: readonly unknown[]) => InvokeArgs<K> {
  return (raw) => {
    assertArgCount(raw, 1, `worktrees ${String(operation)}`);
    return [parse(parseRecord(raw[0], `worktrees ${String(operation)} params`))] as InvokeArgs<K>;
  };
}

function requireCreator(record: ParamsRecord, subject: string): 'agent' | 'user' {
  const createdBy = record['createdBy'];
  if (createdBy !== 'agent' && createdBy !== 'user') {
    throw new Error(`${subject} createdBy must be "agent" or "user"`);
  }
  return createdBy;
}

function parseBranch(value: unknown): WorktreeBranchRequest {
  const record = parseRecord(value, 'worktrees create branch');
  if (record['detached'] === true) {
    assertSupportedKeys(record, ['detached'], 'worktrees create branch');
    return { detached: true };
  }
  assertSupportedKeys(record, ['name'], 'worktrees create branch');
  return { name: requireStringType(record, 'name', 'worktrees create branch') };
}

function parseAdopt(record: ParamsRecord): WorktreeAdoptParams {
  const subject = 'worktrees adopt';
  assertSupportedKeys(record, ['createdBy', 'path', 'runId', 'threadId'], subject);
  const runId = optionalStringType(record, 'runId', subject);
  const threadId = optionalStringType(record, 'threadId', subject);
  return {
    createdBy: requireCreator(record, subject),
    path: requireStringType(record, 'path', subject),
    ...(runId === undefined ? {} : { runId }),
    ...(threadId === undefined ? {} : { threadId }),
  };
}

function parseCreate(record: ParamsRecord): WorktreeCreateParams {
  const subject = 'worktrees create';
  assertSupportedKeys(
    record,
    [
      'baseRef',
      'branch',
      'createdBy',
      'name',
      'repositorySetupDecision',
      'rootId',
      'runId',
      'threadId',
    ],
    subject
  );
  const repositorySetupDecision = record['repositorySetupDecision'];
  let parsedDecision: WorktreeCreateParams['repositorySetupDecision'];
  if (repositorySetupDecision !== undefined) {
    const decision = parseRecord(repositorySetupDecision, `${subject} repositorySetupDecision`);
    assertSupportedKeys(
      decision,
      ['decision', 'repositoryId', 'scriptSha256'],
      `${subject} repositorySetupDecision`
    );
    if (decision['decision'] !== 'approved' && decision['decision'] !== 'denied') {
      throw new Error(`${subject} repositorySetupDecision decision must be "approved" or "denied"`);
    }
    parsedDecision = {
      decision: decision['decision'],
      repositoryId: requireStringType(
        decision,
        'repositoryId',
        `${subject} repositorySetupDecision`
      ),
      scriptSha256: requireStringType(
        decision,
        'scriptSha256',
        `${subject} repositorySetupDecision`
      ),
    };
  }
  const runId = optionalStringType(record, 'runId', subject);
  const threadId = optionalStringType(record, 'threadId', subject);
  return {
    baseRef: requireStringType(record, 'baseRef', subject),
    branch: parseBranch(record['branch']),
    createdBy: requireCreator(record, subject),
    name: requireStringType(record, 'name', subject),
    rootId: requireStringType(record, 'rootId', subject),
    ...(parsedDecision === undefined ? {} : { repositorySetupDecision: parsedDecision }),
    ...(runId === undefined ? {} : { runId }),
    ...(threadId === undefined ? {} : { threadId }),
  };
}

function parseWorktreeId(record: ParamsRecord, operation: string): { worktreeId: string } {
  const subject = `worktrees ${operation}`;
  assertSupportedKeys(record, ['worktreeId'], subject);
  return { worktreeId: requireStringType(record, 'worktreeId', subject) };
}

function parseNoWorktreeArgs(operation: string): (raw: readonly unknown[]) => [] {
  return (raw) => {
    assertArgCount(raw, 0, `worktrees ${operation}`);
    return parseNoArgs();
  };
}

export const worktreesContract = {
  adopt: rawChannel<InvokeArgs<'adopt'>, InvokeResult<'adopt'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.adopt,
    parseArgs: parseOne('adopt', parseAdopt),
    roles: ['visible-ui'],
  }),
  archive: rawChannel<InvokeArgs<'archive'>, InvokeResult<'archive'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.archive,
    parseArgs: parseOne('archive', (record) => {
      const subject = 'worktrees archive';
      assertSupportedKeys(
        record,
        ['confirmIgnoredEntries', 'force', 'runId', 'worktreeId'],
        subject
      );
      const confirmIgnoredEntries = optionalStringType(record, 'confirmIgnoredEntries', subject);
      const force = optionalBoolean(record, 'force', subject);
      const runId = optionalStringType(record, 'runId', subject);
      return {
        worktreeId: requireStringType(record, 'worktreeId', subject),
        ...(confirmIgnoredEntries === undefined ? {} : { confirmIgnoredEntries }),
        ...(force === undefined ? {} : { force }),
        ...(runId === undefined ? {} : { runId }),
      };
    }),
    roles: ['visible-ui'],
  }),
  checkoutStatus: rawChannel<InvokeArgs<'checkoutStatus'>, InvokeResult<'checkoutStatus'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.checkoutStatus,
    parseArgs: parseOne('checkoutStatus', (record) => {
      assertSupportedKeys(record, ['path'], 'worktrees checkoutStatus');
      return { path: requireStringType(record, 'path', 'worktrees checkoutStatus') };
    }),
    roles: ['visible-ui'],
  }),
  create: rawChannel<InvokeArgs<'create'>, InvokeResult<'create'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.create,
    parseArgs: parseOne('create', parseCreate),
    roles: ['visible-ui'],
  }),
  createBranchHere: rawChannel<InvokeArgs<'createBranchHere'>, InvokeResult<'createBranchHere'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.createBranchHere,
    parseArgs: parseOne('createBranchHere', (record) => {
      assertSupportedKeys(record, ['branch', 'worktreeId'], 'worktrees createBranchHere');
      return {
        branch: requireStringType(record, 'branch', 'worktrees createBranchHere'),
        worktreeId: requireStringType(record, 'worktreeId', 'worktrees createBranchHere'),
      };
    }),
    roles: ['visible-ui'],
  }),
  createContext: rawChannel<InvokeArgs<'createContext'>, InvokeResult<'createContext'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.createContext,
    parseArgs: parseOne('createContext', (record) => {
      assertSupportedKeys(record, ['rootId'], 'worktrees createContext');
      return { rootId: requireStringType(record, 'rootId', 'worktrees createContext') };
    }),
    roles: ['visible-ui'],
  }),
  getSettings: rawChannel<InvokeArgs<'getSettings'>, InvokeResult<'getSettings'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.getSettings,
    parseArgs: parseNoWorktreeArgs('getSettings'),
    roles: ['visible-ui'],
  }),
  inspectArchive: rawChannel<InvokeArgs<'inspectArchive'>, InvokeResult<'inspectArchive'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.inspectArchive,
    parseArgs: parseOne('inspectArchive', (record) => parseWorktreeId(record, 'inspectArchive')),
    roles: ['visible-ui'],
  }),
  list: rawChannel<InvokeArgs<'list'>, InvokeResult<'list'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.list,
    parseArgs: parseNoWorktreeArgs('list'),
    roles: ['visible-ui'],
  }),
  listManagedPaths: rawChannel<InvokeArgs<'listManagedPaths'>, InvokeResult<'listManagedPaths'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.managedPaths,
    parseArgs: parseNoWorktreeArgs('listManagedPaths'),
    roles: ['visible-ui'],
  }),
  restore: rawChannel<InvokeArgs<'restore'>, InvokeResult<'restore'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.restore,
    parseArgs: parseOne('restore', (record) => parseWorktreeId(record, 'restore')),
    roles: ['visible-ui'],
  }),
  setSettings: rawChannel<InvokeArgs<'setSettings'>, InvokeResult<'setSettings'>>({
    channel: DESKTOP_IPC_CHANNELS.worktrees.setSettings,
    parseArgs: parseOne('setSettings', (record) => {
      const subject = 'worktrees setSettings';
      assertSupportedKeys(record, ['managedDirectory', 'setupCommand'], subject);
      const managedDirectory = record['managedDirectory'];
      if (managedDirectory !== null && typeof managedDirectory !== 'string') {
        throw new Error(`${subject} managedDirectory must be a string or null`);
      }
      const setupCommand = record['setupCommand'];
      if (
        setupCommand !== null &&
        setupCommand !== 'disabled' &&
        !(Array.isArray(setupCommand) && setupCommand.every((part) => typeof part === 'string'))
      ) {
        throw new Error(`${subject} setupCommand must be null, "disabled", or a string array`);
      }
      return {
        managedDirectory,
        setupCommand: setupCommand as WorktreeSettings['setupCommand'],
      };
    }),
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;

export type WorktreesBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof worktreesContract, WorktreesBridge>
>;
