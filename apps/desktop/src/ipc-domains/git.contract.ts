/**
 * Pure desktop Git IPC contract. Git keeps its established `GitResult`
 * envelope, so every operation is a raw channel. Renderer-controlled input is
 * structurally validated here in main before a handler resolves a workspace
 * root or runs Git. Domain semantics stay in the handlers so their established
 * `GitResult` failures remain data rather than becoming rejected invokes.
 */
import type { GitBridge } from '@brainstrike/app-shell/git-panel';
import type {
  GitAheadBehind,
  GitCommitFile,
  GitCommitResult,
  GitCreateBranchResult,
  GitDiff,
  GitDiffParams,
  GitHistoryPage,
  GitPushPullResult,
  GitRepository,
  GitResult,
  GitStatus,
  GitSwitchBranchResult,
  StructuredFileDiff,
  StructuredFileDiffParams,
} from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  rawChannel,
} from '../platform/ipc-contract';

type ParamsRecord = Readonly<Record<string, unknown>>;

function assertArgCount(raw: readonly unknown[], expected: 1 | 2, operation: string): void {
  if (raw.length !== expected) {
    throw new Error(
      `git ${operation} requires exactly ${expected} argument${expected === 1 ? '' : 's'}`
    );
  }
}

function parseRootId(value: unknown, operation: string): string {
  if (typeof value !== 'string') {
    throw new Error(`git ${operation} requires a string rootId`);
  }
  return value;
}

function parseParams(value: unknown, operation: string): ParamsRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`git ${operation} requires a params object`);
  }
  return value as ParamsRecord;
}

function assertSupportedKeys(
  params: ParamsRecord,
  supported: readonly string[],
  operation: string
): void {
  const supportedKeys = new Set(supported);
  const unsupported = Object.keys(params).filter((key) => !supportedKeys.has(key));
  if (unsupported.length > 0) {
    throw new Error(`git ${operation} received unsupported params: ${unsupported.join(', ')}`);
  }
}

function parseRootOnly(operation: string): (raw: readonly unknown[]) => [rootId: string] {
  return (raw) => {
    assertArgCount(raw, 1, operation);
    return [parseRootId(raw[0], operation)];
  };
}

function parseRequiredParams<T>(
  operation: string,
  validate: (params: ParamsRecord) => T
): (raw: readonly unknown[]) => [rootId: string, params: T] {
  return (raw) => {
    assertArgCount(raw, 2, operation);
    return [parseRootId(raw[0], operation), validate(parseParams(raw[1], operation))];
  };
}

function parseOptionalParams<T extends ParamsRecord>(
  operation: string,
  validate: (params: ParamsRecord) => T
): (raw: readonly unknown[]) => [rootId: string, params: T] {
  return (raw) => {
    if (raw.length !== 1 && raw.length !== 2) {
      throw new Error(`git ${operation} requires one or two arguments`);
    }
    const params = raw.length === 1 || raw[1] === undefined ? {} : parseParams(raw[1], operation);
    return [parseRootId(raw[0], operation), validate(params)];
  };
}

function requireString(params: ParamsRecord, key: string, operation: string): string {
  const value = params[key];
  if (typeof value !== 'string') {
    throw new Error(`git ${operation} ${key} must be a string`);
  }
  return value;
}

function optionalString(params: ParamsRecord, key: string, operation: string): string | undefined {
  const value = params[key];
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`git ${operation} ${key} must be a string`);
  }
  return value;
}

function requireNumber(params: ParamsRecord, key: string, operation: string): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`git ${operation} ${key} must be a number`);
  }
  return value;
}

function parsePathParams(operation: string): (params: ParamsRecord) => { path?: string } {
  return (params) => {
    assertSupportedKeys(params, ['path'], operation);
    const path = optionalString(params, 'path', operation);
    return path === undefined ? {} : { path };
  };
}

function parseDiffParams(params: ParamsRecord): GitDiffParams {
  assertSupportedKeys(params, ['mode', 'path'], 'diff');
  const mode = params['mode'];
  if (mode !== 'working' && mode !== 'staged' && mode !== 'untracked') {
    throw new Error('git diff mode must be "working", "staged", or "untracked"');
  }
  const path = optionalString(params, 'path', 'diff');
  if (mode === 'untracked') {
    if (path === undefined) {
      throw new Error('git diff untracked mode requires a string path');
    }
    return { mode, path };
  }
  return path === undefined ? { mode } : { mode, path };
}

function parseStructuredFileDiffParams(params: ParamsRecord): StructuredFileDiffParams {
  const mode = params['mode'];
  switch (mode) {
    case 'commit': {
      assertSupportedKeys(params, ['commitId', 'mode', 'path'], 'structuredFileDiff');
      return {
        commitId: requireString(params, 'commitId', 'structuredFileDiff commit mode'),
        mode,
        path: requireString(params, 'path', 'structuredFileDiff'),
      };
    }
    case 'range': {
      assertSupportedKeys(params, ['baseRef', 'mode', 'path'], 'structuredFileDiff');
      return {
        baseRef: requireString(params, 'baseRef', 'structuredFileDiff range mode'),
        mode,
        path: requireString(params, 'path', 'structuredFileDiff'),
      };
    }
    case 'staged':
    case 'untracked':
    case 'unstaged':
    case 'working':
      assertSupportedKeys(params, ['mode', 'path'], 'structuredFileDiff');
      return {
        mode,
        path: requireString(params, 'path', 'structuredFileDiff'),
      };
    default:
      throw new Error(
        'git structuredFileDiff mode must be "commit", "range", "staged", "untracked", "unstaged", or "working"'
      );
  }
}

export const gitContract = {
  aheadBehind: rawChannel<[rootId: string], GitResult<GitAheadBehind>>({
    channel: DESKTOP_IPC_CHANNELS.git.aheadBehind,
    parseArgs: parseRootOnly('aheadBehind'),
    roles: ['visible-ui'],
  }),
  commit: rawChannel<
    [rootId: string, params: { description?: string; summary: string }],
    GitResult<GitCommitResult>
  >({
    channel: DESKTOP_IPC_CHANNELS.git.commit,
    parseArgs: parseRequiredParams('commit', (params) => {
      assertSupportedKeys(params, ['description', 'summary'], 'commit');
      const description = optionalString(params, 'description', 'commit');
      const summary = requireString(params, 'summary', 'commit');
      return description === undefined ? { summary } : { description, summary };
    }),
    roles: ['visible-ui'],
  }),
  commitFiles: rawChannel<
    [rootId: string, params: { commit: string }],
    GitResult<readonly GitCommitFile[]>
  >({
    channel: DESKTOP_IPC_CHANNELS.git.commitFiles,
    parseArgs: parseRequiredParams('commitFiles', (params) => {
      assertSupportedKeys(params, ['commit'], 'commitFiles');
      return { commit: requireString(params, 'commit', 'commitFiles') };
    }),
    roles: ['visible-ui'],
  }),
  createBranch: rawChannel<
    [rootId: string, params: { branch: string; startPoint?: string }],
    GitResult<GitCreateBranchResult>
  >({
    channel: DESKTOP_IPC_CHANNELS.git.createBranch,
    parseArgs: parseRequiredParams('createBranch', (params) => {
      assertSupportedKeys(params, ['branch', 'startPoint'], 'createBranch');
      const branch = requireString(params, 'branch', 'createBranch');
      const startPoint = optionalString(params, 'startPoint', 'createBranch');
      return startPoint === undefined ? { branch } : { branch, startPoint };
    }),
    roles: ['visible-ui'],
  }),
  diff: rawChannel<[rootId: string, params: GitDiffParams], GitResult<GitDiff>>({
    channel: DESKTOP_IPC_CHANNELS.git.diff,
    parseArgs: parseRequiredParams('diff', parseDiffParams),
    roles: ['visible-ui'],
  }),
  fetch: rawChannel<[rootId: string, params: { remote: string }], GitResult<GitPushPullResult>>({
    channel: DESKTOP_IPC_CHANNELS.git.fetch,
    parseArgs: parseRequiredParams('fetch', (params) => {
      assertSupportedKeys(params, ['remote'], 'fetch');
      return { remote: requireString(params, 'remote', 'fetch') };
    }),
    roles: ['visible-ui'],
  }),
  history: rawChannel<
    [rootId: string, params: { limit: number; offset: number; ref?: string }],
    GitResult<GitHistoryPage>
  >({
    channel: DESKTOP_IPC_CHANNELS.git.history,
    parseArgs: parseRequiredParams('history', (params) => {
      assertSupportedKeys(params, ['limit', 'offset', 'ref'], 'history');
      const limit = requireNumber(params, 'limit', 'history');
      const offset = requireNumber(params, 'offset', 'history');
      const ref = optionalString(params, 'ref', 'history');
      return ref === undefined ? { limit, offset } : { limit, offset, ref };
    }),
    roles: ['visible-ui'],
  }),
  pull: rawChannel<[rootId: string], GitResult<GitPushPullResult>>({
    channel: DESKTOP_IPC_CHANNELS.git.pull,
    parseArgs: parseRootOnly('pull'),
    roles: ['visible-ui'],
  }),
  push: rawChannel<[rootId: string, params?: { remote?: string }], GitResult<GitPushPullResult>>({
    channel: DESKTOP_IPC_CHANNELS.git.push,
    parseArgs: parseOptionalParams('push', (params) => {
      assertSupportedKeys(params, ['remote'], 'push');
      const remote = optionalString(params, 'remote', 'push');
      return remote === undefined ? {} : { remote };
    }),
    roles: ['visible-ui'],
  }),
  repository: rawChannel<[rootId: string], GitResult<GitRepository>>({
    channel: DESKTOP_IPC_CHANNELS.git.repository,
    parseArgs: parseRootOnly('repository'),
    roles: ['visible-ui'],
  }),
  stage: rawChannel<[rootId: string, params?: { path?: string }], GitResult<null>>({
    channel: DESKTOP_IPC_CHANNELS.git.stage,
    parseArgs: parseOptionalParams('stage', parsePathParams('stage')),
    roles: ['visible-ui'],
  }),
  status: rawChannel<[rootId: string], GitResult<GitStatus>>({
    channel: DESKTOP_IPC_CHANNELS.git.status,
    parseArgs: parseRootOnly('status'),
    roles: ['visible-ui'],
  }),
  structuredFileDiff: rawChannel<
    [rootId: string, params: StructuredFileDiffParams],
    GitResult<StructuredFileDiff>
  >({
    channel: DESKTOP_IPC_CHANNELS.git.structuredFileDiff,
    parseArgs: parseRequiredParams('structuredFileDiff', parseStructuredFileDiffParams),
    roles: ['visible-ui'],
  }),
  switchBranch: rawChannel<
    [rootId: string, params: { branch: string }],
    GitResult<GitSwitchBranchResult>
  >({
    channel: DESKTOP_IPC_CHANNELS.git.switchBranch,
    parseArgs: parseRequiredParams('switchBranch', (params) => {
      assertSupportedKeys(params, ['branch'], 'switchBranch');
      return { branch: requireString(params, 'branch', 'switchBranch') };
    }),
    roles: ['visible-ui'],
  }),
  unstage: rawChannel<[rootId: string, params?: { path?: string }], GitResult<null>>({
    channel: DESKTOP_IPC_CHANNELS.git.unstage,
    parseArgs: parseOptionalParams('unstage', parsePathParams('unstage')),
    roles: ['visible-ui'],
  }),
} satisfies Contract;

export type GitBridgeDerivationProof = AssertTrue<BridgeMatches<typeof gitContract, GitBridge>>;
