/**
 * Tool-lifecycle hooks P2: the Stop-hook notice on the live stream +
 * persistence (FINDING A, direct-drive with the REAL AssistantDataStreamSession
 * — the @brainstrike/agent partial mock spreading `actual` is load-bearing for
 * that), and the hook-blocked turn's failed run status over HTTP (FINDING B).
 * Moved verbatim from the pre-split assistant-server.integration.test.ts
 * (BST-1028 slice 4). Integration lane: both tests write real files and run
 * real shell commands through the hook runner.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssistantDataStreamSession,
  type AssistantRunEvent,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  type RuntimeData,
  type StreamChunk,
} from '@brainstrike/agent';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { desktopAssistantServerLogger, handleAssistantRequest } from '../../assistant-server';
import { createDesktopHookRunner } from '../../assistant-server/hooks/hook-runner-impl';
import {
  buildHookManager,
  finalizeHookedStream,
  hookRunEventToAssistant,
  installDesktopHookApprovalReader,
} from '../../assistant-server/hooks/server-integration';
import { resetDesktopMastraMemoryCacheForTests } from '../../assistant-server/mastra-memory';
import { observeDesktopAssistantRunEvents } from '../../assistant-server/run-persistence';
import { mockDesktopDatabase, mockSecretsService } from './_assistant-server-mocks';
import { createRunRequest } from './_harness';

// Mock dependencies: per-file vi.mock call sites (hoisting is
// per-importing-module) over the shared factory bodies + fixtures in
// _assistant-server-mocks.ts (BST-1029). The DYNAMIC import is LOAD-BEARING
// (both alternatives verified red): a bare imported factory reference is
// evaluated at hoist time, and even a lazy arrow over the STATIC import
// breaks because '../../assistant-server' initializes first in import order
// and triggers these factories before the mocks module's bindings exist. The
// dynamic import shares the same per-file module instance as the static
// fixture imports below.
// vi.hoisted lifts the accessor above the hoisted vi.mock calls; the dynamic
// import inside stays lazy.
const mocks = vi.hoisted(() => () => import('./_assistant-server-mocks'));
vi.mock('../../assistant-server/http', async () => (await mocks()).makeAssistantServerHttpMock());
vi.mock('../../agent-client-loader', async () => (await mocks()).makeAgentClientLoaderMock());
vi.mock('../../secrets', async () => (await mocks()).makeSecretsMock());
vi.mock('@brainstrike/agent/hosted-web', async () => (await mocks()).makeHostedWebAgentMock());
vi.mock('@brainstrike/agent', async () => (await mocks()).makeAgentMock());
vi.mock('@brainstrike/agent/pglite-mastra-memory', async () =>
  (await mocks()).makePgliteMastraMemoryMock()
);
vi.mock('../../assistant-server/assistant-tools', async () =>
  (await mocks()).makeAssistantToolsMock()
);
vi.mock(
  '../../../../../packages/host-capabilities/src/native-tools/workspace-text-file-reader',
  async () => (await mocks()).makeWorkspaceTextFileReaderMock()
);
vi.mock('../../db-main', async () => (await mocks()).makeDbMainMock());

const runRequest = createRunRequest(handleAssistantRequest);

beforeEach(() => {
  mockDesktopDatabase.exec.mockReset();
  mockDesktopDatabase.query.mockReset();
  // Default: workspace-roots enrichment (runs first on every assistant
  // stream init) sees no roots and cleanly falls back. Tests that exercise
  // other queries override this.
  mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
  resetDesktopMastraMemoryCacheForTests();
  mockSecretsService.getCredential
    .mockReset()
    .mockResolvedValue({ key: 'test-api-key', type: 'api_key' });
  mockSecretsService.getKey.mockReset().mockResolvedValue('test-api-key');
  mockSecretsService.listProviders.mockReset().mockResolvedValue(['openai']);
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
});

afterEach(() => {
  vi.clearAllMocks();
  resetDesktopMastraMemoryCacheForTests();
}, 15_000);
describe('tool-lifecycle hooks P2 (Stop notice + blocked-run status)', () => {
  function writeHooksFile(rootAbsPath: string, config: Record<string, unknown>): string {
    const dir = join(rootAbsPath, '.brainstrike');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'hooks.json');
    writeFileSync(file, JSON.stringify(config), 'utf8');
    return file;
  }

  function sha256OfFile(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  // FINDING A: the live data-stream consumer (AssistantDataStreamSession) stops
  // pulling the source the moment the mapper emits `finish`. If the terminal
  // Stop hook only runs AFTER the finish chunk is yielded, its queued
  // hook.notice never reaches EITHER the live stream or persistence. Drive the
  // REAL consumer chain (session + finalizeHookedStream + real observer) and
  // assert the notice lands on both.
  it('FINDING A: a Stop-hook notice reaches the live stream and persistence', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bs-hooks-a-'));
    try {
      const noteText = 'stop-note-visible-xyz';
      const file = writeHooksFile(tmp, {
        Stop: [{ command: `echo '{"additionalContext":"${noteText}"}'`, type: 'command' }],
      });
      const runId = 'run-A';
      const queuedRunEvents: AssistantRunEvent[] = [];
      const manager = buildHookManager({
        approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
        emitRunEvent: (event) => queuedRunEvents.push(hookRunEventToAssistant(event)),
        logger: desktopAssistantServerLogger,
        runtimeData: {
          provider: 'openai',
          workspaceRoots: [{ displayName: 'root', path: tmp, rootId: 'root-1' }],
        } as RuntimeData,
        sessionId: runId,
      });
      expect(manager.hasHooks()).toBe(true);
      const runner = createDesktopHookRunner(manager);

      async function* model(): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', value: 'answer' };
        yield {
          finishReason: 'stop',
          path: [],
          type: 'message-finish',
          usage: { completionTokens: 0, promptTokens: 0 },
        };
      }

      const controller = new AbortController();
      const source = finalizeHookedStream(model(), {
        logger: desktopAssistantServerLogger,
        manager,
        observe: (src) =>
          observeDesktopAssistantRunEvents(
            src,
            runId,
            queuedRunEvents,
            async () => mockDesktopDatabase
          ),
        runner,
        signal: controller.signal,
      });
      const session = new AssistantDataStreamSession(source, () => {});
      const body = await session.createResponse().text();

      // (a) live data-stream output carries the Stop notice.
      expect(body).toContain(noteText);
      // (b) the notice was persisted as a run event (detail is an INSERT param).
      const persistedValues = mockDesktopDatabase.query.mock.calls
        .map((call) => call[1])
        .filter((params): params is unknown[] => Array.isArray(params))
        .flat();
      expect(persistedValues).toContain(noteText);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  }, 15_000);

  // FINDING B: a UserPromptSubmit hook that blocks a fresh turn short-circuits
  // with a visible message + run.failed but returns an `ok:true` stream, so the
  // run row was persisted as `completed`. Drive the real POST path and assert
  // the persisted terminal status is `failed`.
  it('FINDING B: a hook-blocked turn records a failed run status', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bs-hooks-b-'));
    try {
      const file = writeHooksFile(tmp, {
        UserPromptSubmit: [
          { command: `echo '{"reason":"nope-blocked"}'; exit 2`, type: 'command' },
        ],
      });
      const { streamResponse } = await import('../../assistant-server/http');
      (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
        (res as { end?: () => void }).end?.();
      });
      mockDesktopDatabase.query.mockImplementation(async (sql: unknown) =>
        typeof sql === 'string' && sql.includes('FROM roots')
          ? {
              rows: [{ displayName: 'root', id: 'root-1', path: tmp }],
            }
          : { rows: [] }
      );
      // The agent host trusts this root's hooks file at its current hash.
      installDesktopHookApprovalReader(async (root) =>
        root.rootId === 'root-1' && root.absPath === tmp ? sha256OfFile(file) : undefined
      );

      await runRequest({
        body: JSON.stringify({
          data: {
            memory: {
              // OM enabled-by-default resolves a provider model target; disable
              // it so run-scoped memory constructs from the mock alone.
              memorySettings: {
                ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
                observationalMemory: {
                  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
                  enabled: false,
                },
              },
              resourceId: 'res-B',
              runId: 'run-B',
              threadId: 'thread-B',
            },
            provider: 'openai',
            workspaceRoots: [{ displayName: 'root', path: tmp, rootId: 'root-1' }],
          },
          messages: [{ parts: [{ text: 'do a thing', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      });

      const statusUpdate = mockDesktopDatabase.query.mock.calls.find(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('brainstrike_assistant_thread_runs') &&
          sql.includes('SET status')
      );
      expect(statusUpdate).toBeDefined();
      const params = statusUpdate?.[1] as unknown[] | undefined;
      // Failed status is literal in the atomic root/child terminal statement.
      expect(statusUpdate?.[0]).toContain("SET status = 'failed', error = $2");
      expect(params).toEqual(['run-B', 'nope-blocked']);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  }, 15_000);
});
