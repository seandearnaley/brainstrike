import { wireResultDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import type { Schema } from 'effect';
import { expect, test } from 'vitest';
import type { z } from 'zod';
import * as command from '../agent-host-platform/command-session-wire';
import * as tools from '../agent-host-platform/host-tool-wire';
import * as oldCommand from './fixtures/e05/pre-effect-command-session-wire';
import * as oldTools from './fixtures/e05/pre-effect-host-tool-wire';

const session = {
  createdAt: 1,
  cwd: '/workspace',
  id: 's',
  pid: 12,
  rootId: 'r',
  status: 'running',
};
const failure = { error: { code: 'session-not-found', message: 'missing' }, ok: false };
const subjects: readonly [
  string,
  Schema.ConstraintDecoder<unknown>,
  z.ZodType,
  'error' | 'ignore',
  readonly unknown[],
][] = [
  [
    'list request',
    command.HostCommandSessionListRequestSchema,
    oldCommand.HostCommandSessionListRequestSchema,
    'error',
    [{ rootId: 'r' }],
  ],
  [
    'read request',
    command.HostCommandSessionReadRequestSchema,
    oldCommand.HostCommandSessionReadRequestSchema,
    'error',
    [
      { rootId: 'r', sessionId: 's' },
      { cursor: 0, rootId: 'r', sessionId: 's' },
      { cursor: undefined, rootId: 'r', sessionId: 's' },
    ],
  ],
  [
    'write request',
    command.HostCommandSessionWriteRequestSchema,
    oldCommand.HostCommandSessionWriteRequestSchema,
    'error',
    [{ data: '', rootId: 'r', sessionId: 's' }],
  ],
  [
    'identity',
    command.HostCommandSessionIdentitySchema,
    oldCommand.HostCommandSessionIdentitySchema,
    'error',
    [{ rootId: 'r', sessionId: 's' }],
  ],
  [
    'list result',
    command.HostCommandSessionListResultSchema,
    oldCommand.HostCommandSessionListResultSchema,
    'ignore',
    [
      {
        ok: true,
        value: {
          rootId: 'r',
          sessions: [
            session,
            { ...session, exitCode: 0, exitedAt: 2, signal: null, status: 'exited' },
          ],
        },
      },
      failure,
    ],
  ],
  [
    'read result',
    command.HostCommandSessionReadResultSchema,
    oldCommand.HostCommandSessionReadResultSchema,
    'ignore',
    [
      {
        ok: true,
        value: {
          bufferStartCursor: 0,
          hasMore: false,
          nextCursor: 2,
          output: 'hi',
          requestedCursor: 0,
          session,
          truncatedBeforeCursor: false,
        },
      },
      failure,
    ],
  ],
  [
    'done result',
    command.HostCommandSessionDoneResultSchema,
    oldCommand.HostCommandSessionDoneResultSchema,
    'ignore',
    [{ ok: true }, failure],
  ],
  [
    'dispose root result',
    command.HostCommandSessionDisposeRootResultSchema,
    oldCommand.HostCommandSessionDisposeRootResultSchema,
    'ignore',
    [{ disposed: 0 }, { disposed: 1 }, { disposed: -1 }, { disposed: Number.MAX_SAFE_INTEGER + 1 }],
  ],
  [
    'shell completed',
    tools.PlatformShellCompletedSchema,
    oldTools.PlatformShellCompletedSchema,
    'error',
    [
      { command: 'x', precedingWorktreePaths: null, rootId: 'r', threadId: 't' },
      { command: 'x', precedingWorktreePaths: [], rootId: 'r', runId: undefined, threadId: 't' },
    ],
  ],
  [
    'shell result',
    tools.PlatformShellCompletedResultSchema,
    oldTools.PlatformShellCompletedResultSchema,
    'error',
    [{ adopted: [{ branch: null, path: '/w', worktreeId: 'w' }] }],
  ],
  [
    'paths',
    tools.WorktreePathsResultSchema,
    oldTools.WorktreePathsResultSchema,
    'error',
    [{ paths: null }, { paths: ['/w'] }],
  ],
  [
    'grep options',
    tools.GrepIndexOptionsSchema,
    oldTools.GrepIndexOptionsSchema,
    'error',
    [
      { pattern: 'x' },
      { caseSensitive: true, maxResults: 1, pattern: 'x', rootIds: ['r'] },
      { maxResults: undefined, pattern: 'x' },
      { maxResults: Number.MAX_SAFE_INTEGER + 1, pattern: 'x' },
    ],
  ],
  [
    'grep request',
    tools.GrepIndexRequestSchema,
    oldTools.GrepIndexRequestSchema,
    'error',
    [
      { options: { pattern: 'x' }, threadId: 't' },
      { options: { pattern: 'x', rider: true }, threadId: 't' },
    ],
  ],
  [
    'grep result',
    tools.GrepIndexResultSchema,
    oldTools.GrepIndexResultSchema,
    'error',
    [
      {
        candidatesTruncated: false,
        matches: [{ after: [], before: [], line: 1, lineText: 'x', path: 'p' }],
        scanLimited: false,
        skippedMissingLineMetadata: 0,
        totalMatches: 1,
        truncated: false,
      },
    ],
  ],
  [
    'worktree create',
    tools.WorktreeCreateRequestSchema,
    oldTools.WorktreeCreateRequestSchema,
    'error',
    [{ params: { baseRef: 'main', branch: 'branch', name: 'n', rootId: 'r' }, threadId: 't' }],
  ],
  [
    'worktree archive',
    tools.WorktreeArchiveRequestSchema,
    oldTools.WorktreeArchiveRequestSchema,
    'error',
    [
      { params: { worktreeId: 'w' }, threadId: 't' },
      { params: { force: undefined, worktreeId: 'w' }, threadId: 't' },
    ],
  ],
  [
    'worktree create result',
    tools.WorktreeCreateResultSchema,
    oldTools.WorktreeCreateResultSchema,
    'ignore',
    [
      {
        ok: true,
        value: {
          setup: { reason: null, status: 'done' },
          worktree: { branch: null, id: 'w', path: '/w' },
        },
      },
      { error: 'failure', ok: false },
    ],
  ],
  [
    'worktree archive result',
    tools.WorktreeArchiveResultSchema,
    oldTools.WorktreeArchiveResultSchema,
    'ignore',
    [{ ok: true, value: { snapshotRef: 'ref', worktree: { id: 'w' } } }],
  ],
  [
    'worktree list result',
    tools.WorktreeListResultSchema,
    oldTools.WorktreeListResultSchema,
    'ignore',
    [{ ok: true, value: [] }],
  ],
  [
    'browser navigate result',
    tools.BrowserNavigateResultSchema,
    oldTools.BrowserNavigateResultSchema,
    'ignore',
    [
      { ok: true, title: 'title', url: 'https://example.com' },
      { error: 'blocked_url', hint: 'blocked', ok: false },
    ],
  ],
  [
    'browser tree result',
    tools.BrowserReadPageResultSchema,
    oldTools.BrowserReadPageResultSchema,
    'ignore',
    [{ ok: true, tree: 'tree', truncated: false }],
  ],
  [
    'browser text result',
    tools.BrowserPageTextResultSchema,
    oldTools.BrowserPageTextResultSchema,
    'ignore',
    [{ ok: true, text: 'text', truncated: true }],
  ],
  [
    'diagnostic request',
    tools.DiagnosticsReadRequestSchema,
    oldTools.DiagnosticsReadRequestSchema,
    'error',
    [
      { filter: { limit: 200, severity: 'error' }, threadId: 't' },
      { filter: { limit: 201 }, threadId: 't' },
      { filter: { limit: undefined }, threadId: 't' },
    ],
  ],
  [
    'diagnostic fingerprints',
    tools.DiagnosticFingerprintItemsSchema,
    oldTools.DiagnosticFingerprintItemsSchema,
    'ignore',
    [
      [
        {
          code: null,
          count: 1,
          fingerprint: 'f',
          firstSeenMs: 1,
          lastSeenMs: 2,
          latestMessage: 'safe',
          latestMessageTruncated: false,
          rider: true,
          severity: 'error',
          source: 's',
        },
      ],
    ],
  ],
  [
    'diagnostic events',
    tools.DiagnosticEventItemsSchema,
    oldTools.DiagnosticEventItemsSchema,
    'ignore',
    [
      [
        {
          causeChainJson: null,
          causeChainTruncated: false,
          code: null,
          contextJson: null,
          contextTruncated: false,
          fingerprint: 'f',
          id: 'i',
          message: 'safe',
          messageTruncated: false,
          occurredAt: 1,
          resourceId: null,
          rider: true,
          rootId: null,
          runId: null,
          scope: null,
          sessionId: 's',
          severity: 'warn',
          source: 's',
          stack: null,
          stackTruncated: false,
          threadId: null,
        },
      ],
    ],
  ],
];
for (const [name, schema, oracle, policy, examples] of subjects) {
  const decode = wireResultDecoder(schema, { errors: 'all', onExcessProperty: policy });
  const inputs = [
    ...examples,
    undefined,
    null,
    [],
    false,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    {},
    'x',
    ...examples
      .filter(
        (value): value is object =>
          typeof value === 'object' && value !== null && !Array.isArray(value)
      )
      .map((value) => ({ ...value, rider: true })),
  ];
  test.each(inputs.map((value, index) => ({ index, value })))(
    `${name} preserves acceptance and output $index`,
    ({ value }) => {
      const old = oracle.safeParse(value),
        current = decode(value);
      expect(current._tag === 'Success').toBe(old.success);
      if (old.success && current._tag === 'Success') {
        expect(current.success).toEqual(old.data);
      }
    }
  );
}
