import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ProcessMetric } from 'electron';
import { HomePage } from '../../e2e/page-objects/home-page';
import { SettingsPage } from '../../e2e/page-objects/settings-page';
import { configureAssistantProvider } from '../../e2e/utils/assistant-mock';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from '../../e2e/utils/layout-helpers';
import {
  startToolOutputFixture,
  type ToolOutputFixture,
} from '../../e2e/utils/mcp-tool-output-fixture';
import type {
  ModelProviderRequest,
  ModelProviderScript,
  ModelProviderShim,
  ScriptedToolCall,
} from '../../e2e/utils/model-provider-shim';
import type { EMBEDDING_HOST_QUERY_CANCELED_CODE } from '../../src/embedding-host-shared';
import { type ArtifactFlow, createArtifactFlow } from './artifact-flow';
import {
  type CandidateSession,
  createCandidateSession,
  readNativeSnapshot,
  waitForTextIndex,
} from './candidate';
import { nativeBuildComplete } from './native-benchmark';
import { configureNativeText, readSavedChoices } from './native-settings';
import { startCapturingProvider, toolMessages } from './provider-capture';
import type { PublicBridges } from './public-bridges';
import { readIndexQueryStopEvidence, requireIndexQueryStopEvidence } from './query-stop-evidence';
import { observeSemanticQuery, type SemanticObservation } from './semantic-stop';
import { assertActualVectorWorker, configureVectorProfile } from './vector-profile';

// runTools creates the three committed source files plus the canonical SQL lens.
// Artifact preparation changes an existing source; it adds no fifth file.
const TOOL_CORPUS_FILE_COUNT = 4;
// Compile-time pin to the public contract without loading the application's inference modules.
const QUERY_CANCELED_CODE: typeof EMBEDDING_HOST_QUERY_CANCELED_CODE =
  'EMBEDDING_HOST_QUERY_CANCELED';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const decoded: unknown = JSON.parse(value);
      return decoded === value ? value : outputText(decoded);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map(outputText).join('\n');
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).map(outputText).join('\n');
  }
  return String(value);
}

function requireToolCallId(message: unknown): string {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('role' in message) ||
    message.role !== 'tool' ||
    !('tool_call_id' in message) ||
    typeof message.tool_call_id !== 'string' ||
    message.tool_call_id.length === 0
  ) {
    throw new Error('Expected the actual returned tool-call identity.');
  }
  return message.tool_call_id;
}

async function runTools(
  label: string,
  script: ModelProviderScript | ((request: ModelProviderRequest) => ModelProviderScript),
  verify: (outputs: readonly unknown[]) => void,
  prepare?: (root: string, session: CandidateSession) => Promise<void>,
  vectors = false,
  exercise?: (
    context: ElectronAppContext,
    session: CandidateSession,
    provider: ModelProviderShim
  ) => Promise<void>,
  configure?: (context: ElectronAppContext, session: CandidateSession) => Promise<void>
): Promise<void> {
  const session = await createCandidateSession(label);
  const corpus = path.join(session.runDir, 'corpus');
  await cp(path.join(import.meta.dirname, 'corpus'), corpus, { recursive: true });
  const lens = await readFile(
    path.join(session.candidateRoot, '.brainstrike/lenses/callers-hybrid.sql')
  );
  await mkdir(path.join(corpus, '.brainstrike/lenses'), { recursive: true });
  await writeFile(path.join(corpus, '.brainstrike/lenses/callers-hybrid.sql'), lens);
  await session.record('canonical-lens', {
    bytes: lens.length,
    sha256: createHash('sha256').update(lens).digest('hex'),
  });
  await prepare?.(corpus, session);
  const provider = await startCapturingProvider(script);
  try {
    const context = await session.launch({
      ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: corpus,
      ['BRAINSTRIKE_OPENROUTER_API_KEY']: 'test-key-m2-qualification',
      ['OPENROUTER_BASE_URL']: provider.baseUrl,
    });
    await configureNativeText(context);
    await context.window.getByTestId('select-root-button').click();
    await waitForTextIndex(context, TOOL_CORPUS_FILE_COUNT);
    if (vectors) {
      const configured = await configureVectorProfile(context);
      if (
        configured.status.kind !== 'ready' ||
        configured.status.embedding.indexMode !== 'vector-configured'
      ) {
        throw new Error('Native vector profile did not configure.');
      }
      const rootId = configured.status.authorizedRootIds[0];
      if (!rootId) {
        throw new Error('Authorized root is unavailable.');
      }
      const scope = {
        files: TOOL_CORPUS_FILE_COUNT,
        mode: 'vector' as const,
        profile: configured.status.embedding.profile,
        rootId,
        storeId: configured.status.storeId,
      };
      await expect
        .poll(
          async () => {
            const snapshot = await readNativeSnapshot(context);
            return nativeBuildComplete(snapshot.status, snapshot.coverage, scope);
          },
          { timeout: 480_000 }
        )
        .toBe(true);
      const complete = await readNativeSnapshot(context);
      assertActualVectorWorker(complete);
      await session.record('full-vector-coverage-before-tools', complete);
    }
    await configure?.(context, session);
    await configureAssistantProvider(context.window, {
      apiKey: 'test-key-m2-qualification',
      compositeModelKey: 'openrouter::openai/gpt-5.4',
      provider: 'openrouter',
    });
    await new HomePage(context.window).openSettings();
    await new SettingsPage(context.window).openCategory(/Permissions/i, 'permissions');
    await context.window
      .getByRole('combobox', { exact: true, name: 'Execute permission' })
      .selectOption('allow');
    await ensureAssistantShellVisible(context.window);
    const panel = context.window.getByTestId('chat-panel');
    await panel
      .getByRole('textbox', { name: 'Message input' })
      .fill(`Run the M2 ${label} acceptance tools.`);
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await exercise?.(context, session, provider);
    await expect(panel.getByText('M2 qualification tools completed', { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await session.record('real-assistant-tools', {
      capture: {
        lastUserMessage: provider
          .lastRequest()
          ?.messages.findLast(
            (message) =>
              typeof message === 'object' &&
              message !== null &&
              'role' in message &&
              message.role === 'user'
          ),
        requestIndex: provider.lastRequest()?.requestIndex,
      },
      outputs: provider.outputs(),
      transcript: provider.transcript(),
    });
    verify(provider.outputs());
    await context.window.screenshot({ path: path.join(session.runDir, 'tools-completed.png') });
  } catch (error) {
    await session.record('failure', {
      message: String(error),
      outputs: provider.outputs(),
      transcript: provider.transcript(),
    });
    throw error;
  } finally {
    try {
      await session.close();
    } finally {
      await provider.close();
    }
  }
}

const query = (arguments_: Record<string, unknown>): ScriptedToolCall => ({
  arguments: arguments_,
  name: 'brainstrike_querySelf',
});

test('real visible Stop terminates a pending native index query and a fresh request recovers', async () => {
  const sql =
    'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r';
  let explained: readonly unknown[] = [];
  const completedBeforeStop = new Set<string>();
  await runTools(
    'query-self-stop',
    (request) => {
      if (request.toolNames.length === 0) {
        return { finalText: 'Native query Stop qualification' };
      }
      const outputs = toolMessages(request);
      for (const output of outputs) {
        completedBeforeStop.add(requireToolCallId(output));
      }
      if (outputs.length === 2) {
        explained = outputs;
      }
      return {
        finalText: 'M2 pending query unexpectedly completed',
        toolCallStages: [
          [{ arguments: { toolName: 'brainstrike_querySelf' }, name: 'load_tool' }],
          [query({ mode: 'explain', sql, target: 'index' })],
          [query({ mode: 'query', sql, target: 'index' })],
        ],
      };
    },
    (outputs) => {
      expect(outputs).toHaveLength(2);
      const recoveryCallId = requireToolCallId(outputs[1]);
      expect(completedBeforeStop.size).toBe(2);
      expect(completedBeforeStop.has(recoveryCallId)).toBe(false);
      expect(requireToolCallId(outputs[0])).not.toBe(recoveryCallId);
      expect(outputText(outputs[1])).toContain('m2_after_user_stop');
      expect(outputText(outputs[1])).toContain('1941');
      expect(outputText(outputs)).not.toMatch(/deadline|tool_failed|tool_timeout/i);
    },
    undefined,
    false,
    async (context, session, provider) => {
      const panel = context.window.getByTestId('chat-panel');
      const stdout: string[] = [];
      const observeOutput = (chunk: Buffer): void => {
        stdout.push(chunk.toString('utf8'));
      };
      const child = context.app.process();
      if (!child.stdout) {
        throw new Error('Native query diagnostics require actual main stdout.');
      }
      child.stdout.on('data', observeOutput);
      const metricsStartedAt = performance.now();
      interface MetricSnapshot {
        elapsedMs: number;
        utilities: {
          creationTime: number;
          live: boolean;
          name: string | null;
          pid: number;
          serviceName: string | null;
        }[];
      }
      const metricSnapshots: MetricSnapshot[] = [];
      let lastMetricSnapshot: MetricSnapshot | undefined;
      let lastMetricIdentity = '';
      let droppedMetricTransitions = 0;
      let owner: ProcessMetric | undefined;
      try {
        // Protected EXPLAIN checks this SQL; the later cancellation diagnostic
        // must still prove the new reader admitted its query. Admission, limits
        // and the production one-second query deadline remain unchanged.
        await expect
          .poll(() =>
            provider
              .transcript()
              .some(
                (turn) =>
                  turn.decision === 'tool:brainstrike_querySelf' && turn.toolResultCount === 2
              )
          )
          .toBe(true);
        expect(outputText(explained[1])).toContain('plan');
        expect(outputText(explained[1])).not.toMatch(/tool_failed|tool_input_invalid|deadline/i);
        const running = panel
          .getByTestId('activity-step-row')
          .and(panel.locator('[title="brainstrike.querySelf"][data-state="running"]'));
        // Observe public metrics alongside UI readiness within the unchanged
        // query deadline. fork's serviceName option becomes ProcessMetric.name.
        const readiness = await Promise.allSettled([
          expect(running).toHaveCount(1),
          expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible(),
          expect
            .poll(
              async () => {
                const metrics = await context.app.evaluate(({ app }) => app.getAppMetrics());
                const utilities = metrics
                  .filter((metric) => metric.type === 'Utility')
                  .map((metric) => ({ live: isProcessAlive(metric.pid), metric }));
                lastMetricSnapshot = {
                  elapsedMs: performance.now() - metricsStartedAt,
                  utilities: utilities.map(({ live, metric }) => ({
                    creationTime: metric.creationTime,
                    live,
                    name: metric.name ?? null,
                    pid: metric.pid,
                    serviceName: metric.serviceName ?? null,
                  })),
                };
                const identity = JSON.stringify(lastMetricSnapshot.utilities);
                if (identity !== lastMetricIdentity) {
                  if (metricSnapshots.length < 32) {
                    metricSnapshots.push(lastMetricSnapshot);
                  } else {
                    droppedMetricTransitions += 1;
                  }
                  lastMetricIdentity = identity;
                }
                const readers = utilities.filter(
                  ({ live, metric }) => live && metric.name === 'brainstrike-index-query'
                );
                owner = readers.length === 1 ? readers[0]?.metric : undefined;
                return readers.length;
              },
              { intervals: [10], timeout: 15_000 }
            )
            .toBe(1),
        ]);
        for (const result of readiness) {
          if (result.status === 'rejected') {
            throw result.reason;
          }
        }
        if (!owner) {
          throw new Error('Actual pending index query owner disappeared.');
        }
        const queryOwner = owner;
        expect(isProcessAlive(queryOwner.pid)).toBe(true);
        const stopStartedAt = performance.now();
        const [response] = await Promise.all([
          context.window.waitForResponse(
            (value) =>
              new URL(value.url()).pathname === '/assistant/cancel' &&
              value.request().method() === 'POST'
          ),
          panel.getByRole('button', { exact: true, name: 'Stop' }).click(),
        ]);
        const request: unknown = response.request().postDataJSON();
        if (
          typeof request !== 'object' ||
          request === null ||
          !('runId' in request) ||
          typeof request.runId !== 'string'
        ) {
          throw new Error('Visible Stop supplied no validated native run identity.');
        }
        const acknowledgement: unknown = await response.json();
        const after = await context.app.evaluate(({ app }) => app.getAppMetrics());
        await session.record('visible-query-stop', {
          acknowledgement,
          metricsAfterAcknowledgement: after,
          ownerBeforeStop: queryOwner,
          protectedExplainResult: explained[1],
          request,
          responseStatus: response.status(),
          stopDurationMs: performance.now() - stopStartedAt,
        });
        expect(response.status()).toBe(200);
        expect(acknowledgement).toEqual({ accepted: true, runId: request.runId });
        // Electron's metrics inventory may briefly retain an exited PID;
        // actual process absence is the authoritative termination check.
        expect(() => process.kill(queryOwner.pid, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        );
        const durable = await context.window.evaluate(async (id) => {
          const query = (
            window as typeof window & {
              electronAPI: {
                db: {
                  query: (
                    sql: string,
                    params: unknown[]
                  ) => Promise<{ rows: { status: string }[] }>;
                };
              };
            }
          ).electronAPI.db.query;
          return (
            await query('SELECT status FROM brainstrike_assistant_thread_runs WHERE id = $1', [id])
          ).rows;
        }, request.runId);
        await session.record('query-stop-durable-run', durable);
        expect(durable).toEqual([{ status: 'cancelled' }]);
        await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
        const stopped = panel
          .getByTestId('activity-step-row')
          .and(panel.locator('[title="brainstrike.querySelf"]'))
          .last();
        await expect(stopped).toHaveAttribute('data-state', 'cancelled');
        await session.record(
          'query-stop-visible-tool-state',
          await stopped.getAttribute('data-state')
        );
        await session.record('query-stop-native-output', stdout);
        expect(stdout.join('')).not.toMatch(
          /SqliteQueryDeadlineError|Query exceeded its \d+ ms deadline/
        );
        await expect
          .poll(() => readIndexQueryStopEvidence(stdout, queryOwner.pid), {
            intervals: [10],
            timeout: 3000,
          })
          .not.toBeNull();
        await session.record(
          'query-stop-admitted-request',
          requireIndexQueryStopEvidence(stdout, queryOwner.pid)
        );
        provider.setScript((request) => {
          expect(
            outputText(
              request.messages.findLast(
                (message) =>
                  typeof message === 'object' &&
                  message !== null &&
                  'role' in message &&
                  message.role === 'user'
              )
            )
          ).toContain('Run a fresh guarded native query after my Stop.');
          return {
            finalText: 'M2 qualification tools completed',
            toolCallStages: [
              [{ arguments: { toolName: 'brainstrike_querySelf' }, name: 'load_tool' }],
              [query({ mode: 'query', sql: 'SELECT 1941 AS m2_after_user_stop', target: 'index' })],
            ],
          };
        });
        await panel
          .getByRole('textbox', { name: 'Message input' })
          .fill('Run a fresh guarded native query after my Stop.');
        await panel.getByRole('button', { exact: true, name: 'Send' }).click();
        await expect(
          panel.getByText('M2 qualification tools completed', { exact: true })
        ).toBeVisible({ timeout: 90_000 });
        await expect(
          panel.getByText('M2 pending query unexpectedly completed', { exact: true })
        ).toHaveCount(0);
        expect(stdout.join('')).not.toMatch(
          /SqliteQueryDeadlineError|Query exceeded its \d+ ms deadline/
        );
      } finally {
        child.stdout?.off('data', observeOutput);
        await session.record('query-stop-process-metrics', {
          droppedMetricTransitions,
          lastMetricSnapshot,
          snapshots: metricSnapshots,
        });
        await session.record('query-stop-native-output-final', stdout);
      }
    }
  );
});

test('real assistant querySelf app/index, lens routing, text caller refusal and guarded recovery', async () => {
  await runTools(
    'query-self-text',
    {
      finalText: 'M2 qualification tools completed',
      toolCallStages: [
        [{ arguments: { toolName: 'brainstrike_querySelf' }, name: 'load_tool' }],
        [query({ mode: 'query', sql: 'SELECT 1912 AS m2_app_target', target: 'app' })],
        [
          query({
            mode: 'query',
            sql: 'SELECT COUNT(*) AS m2_native_files FROM file_records',
            target: 'index',
          }),
        ],
        [query({ mode: 'listLenses', target: 'index' })],
        [
          query({
            lens: 'callers-hybrid',
            mode: 'lens',
            target: 'index',
            values: ['attachMcpAppShellBridge', 'attachMcpAppShellBridge'],
          }),
        ],
        // Reuse the protected sandbox fixture so a syntax error cannot stand in
        // for the authorizer's actual attachment refusal.
        [query({ mode: 'query', sql: "ATTACH ':memory:' AS other", target: 'index' })],
        [
          query({
            mode: 'query',
            sql: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r',
            target: 'index',
          }),
        ],
        [query({ mode: 'query', sql: 'SELECT 1941 AS m2_after_refusal', target: 'index' })],
      ],
    },
    (outputs) => {
      expect(outputs).toHaveLength(8);
      expect(outputText(outputs[1])).toContain('1912');
      expect(outputText(outputs[2])).toMatch(
        new RegExp(`m2_native_files\\n${TOOL_CORPUS_FILE_COUNT}(?:\\n|$)`)
      );
      expect(outputText(outputs[3])).toContain('callers-hybrid');
      expect(outputText(outputs[4])).toMatch(/vector|profile/i);
      expect(outputText(outputs[5])).toMatch(
        /not authorized|prohibited|denied|not allowed|readonly|read-only/i
      );
      expect(outputText(outputs[6])).toMatch(/deadline/i);
      expect(outputText(outputs[7])).toContain('1941');
    }
  );
});

test('real assistant callers-hybrid executes after full native vector publication', async () => {
  test.setTimeout(600_000);
  await runTools(
    'callers-vector',
    {
      finalText: 'M2 qualification tools completed',
      toolCallStages: [
        [{ arguments: { toolName: 'brainstrike_querySelf' }, name: 'load_tool' }],
        [
          query({
            lens: 'callers-hybrid',
            mode: 'lens',
            target: 'index',
            values: ['attachMcpAppShellBridge', 'attachMcpAppShellBridge'],
          }),
        ],
      ],
    },
    (outputs) => {
      expect(outputs).toHaveLength(2);
      const actual = outputText(outputs[1]);
      expect(actual).toMatch(/rows \| returned=[1-9]/);
      expect(actual).toContain('rrf_score');
      expect(actual).toContain('bridges.ts');
    },
    undefined,
    true
  );
});

test('real stored tool output search finds a match beyond the first 8000 bytes', async () => {
  const marker = 'M2_ARTIFACT_MATCH_AFTER_8000';
  let fixture: ToolOutputFixture | undefined;
  let artifactSession: CandidateSession | undefined;
  let flow: ArtifactFlow | undefined;
  let serializedProducer = '';
  try {
    await runTools(
      'artifact-search',
      (request) => {
        if (!flow) {
          throw new Error('The real MCP artifact flow did not start.');
        }
        return flow.select(request);
      },
      () => {
        if (!(fixture && flow)) {
          throw new Error('No actual producer fixture and retained flow state.');
        }
        const proof = flow.snapshot();
        expect(proof.stage).toBe('complete');
        expect(proof.responses.length).toBeGreaterThan(4);
        expect(fixture.snapshot().toolCalls).toBe(1);
        expect(proof.initialPage?.content).not.toContain(marker);
        expect(proof.recovered).toMatchObject({
          artifactRef: { byteLength: 30_735, format: 'json' },
          endByte: 30_735,
          matches: [
            expect.objectContaining({
              line: 1,
              lineText: expect.stringContaining(marker),
              offsetByte: proof.initialPage?.endByte,
            }),
          ],
          offsetByte: proof.initialPage?.endByte,
          searchLimited: false,
          type: 'artifact_search',
        });
        expect(JSON.stringify(proof.recovered)).not.toContain('storage_failed');
      },
      async (root, session) => {
        artifactSession = session;
        const file = path.join(root, 'disposer-stack.ts');
        const source = await readFile(file, 'utf8');
        const prefix = `${source}\n${'// first-page-padding\n'.repeat(600)}`;
        await writeFile(file, `${prefix}// ${marker}\n`.padEnd(30_000, ' '));
        const corpusText = await readFile(file, 'utf8');
        const bytes = Buffer.from(corpusText);
        expect(bytes.length).toBe(30_002);
        expect(bytes.indexOf(marker)).toBe(15_864);
        // The SDK normalizes text content fields to type then text on the wire.
        serializedProducer = JSON.stringify({
          content: [
            Object.fromEntries([
              ['type', 'text'],
              ['text', corpusText],
            ]),
          ],
        });
        expect(Buffer.byteLength(serializedProducer)).toBe(30_735);
        fixture = await startToolOutputFixture(corpusText);
        flow = createArtifactFlow({ marker, serializedProducer, serverName: fixture.serverName });
        await session.record('mcp-output-fixture', {
          bytes: bytes.length,
          markerOffsetByte: bytes.indexOf(marker),
          serverName: fixture.serverName,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          toolName: fixture.toolName,
          url: fixture.url,
        });
      },
      false,
      undefined,
      async (context, session) => {
        if (!fixture) {
          throw new Error('The real MCP output fixture is unavailable for Settings.');
        }
        await new HomePage(context.window).openSettings();
        await new SettingsPage(context.window).openCategory(/AI Tools/i, 'ai-tools');
        await context.window.getByRole('tab', { name: 'MCP Config' }).click();
        const editor = context.window.getByTestId('mcp-config-editor');
        await expect(editor).toBeVisible({ timeout: 30_000 });
        await editor.fill(fixture.config);
        await context.window.getByTestId('mcp-config-save').click();
        await expect(context.window.getByTestId('mcp-config-status')).toHaveText(
          'MCP config saved.'
        );
        await context.window.getByRole('tab', { name: 'Tools' }).click();
        await expect(
          context.window.getByTestId(`mcp-server-row-${fixture.serverName}`)
        ).toContainText(/Connected/i, { timeout: 60_000 });
        await expect(
          context.window
            .getByTestId(`mcp-server-catalog-${fixture.serverName}`)
            .getByText(fixture.toolName, { exact: true })
        ).toBeVisible({ timeout: 60_000 });
        await session.record('mcp-output-registered', fixture.snapshot());
      }
    );
  } finally {
    try {
      if (flow) {
        await artifactSession?.record('artifact-flow-state', flow.snapshot());
      }
    } finally {
      if (fixture) {
        const beforeClose = fixture.snapshot();
        const closed = await fixture.close();
        await artifactSession?.record('mcp-output-fixture-cleanup', { beforeClose, closed });
        expect(closed).toMatchObject({
          activeRequests: 0,
          clean: true,
          handlersClosed: 1,
          httpListenersClosed: 1,
          listening: false,
          openSockets: 0,
        });
      }
    }
  }
});

test('real semantic assistant Stop joins admitted hidden query and a fresh query recovers', async () => {
  test.setTimeout(600_000);
  const term = 'M2 semantic physical stop DisposerStack';
  let collectionId: string | undefined;
  let observation: SemanticObservation | undefined;
  await runTools(
    'semantic-query-stop',
    () => {
      if (!collectionId) {
        throw new Error('Saved actual semantic collection is unavailable.');
      }
      return {
        finalText: 'M2 semantic request completed before Stop',
        toolCallStages: [
          [{ arguments: { toolName: 'brainstrike_queryEmbeddingSpace' }, name: 'load_tool' }],
          [
            {
              arguments: { embeddingSetId: collectionId, query: term },
              name: 'brainstrike_queryEmbeddingSpace',
            },
          ],
        ],
      };
    },
    (outputs) => {
      expect(outputs).toHaveLength(2);
      expect(outputText(outputs[1])).not.toMatch(/tool_failed|tool_timeout|deadline/i);
      expect(outputText(outputs[1])).toContain('disposer-stack.ts');
    },
    undefined,
    true,
    async (context, session, provider) => {
      if (!observation) {
        throw new Error('Semantic physical observation is not armed.');
      }
      const observe = observation;
      const panel = context.window.getByTestId('chat-panel');
      try {
        let admitted: Awaited<ReturnType<typeof observe.events>>[number] | undefined;
        await expect
          .poll(
            async () => {
              admitted = (await observe.events()).find(
                (event) =>
                  event.kind === 'request' &&
                  'query' in event.value.payload &&
                  event.value.payload.query === term
              );
              return admitted !== undefined;
            },
            { intervals: [10], timeout: 15_000 }
          )
          .toBe(true);
        if (admitted?.kind !== 'request' || !('query' in admitted.value.payload)) {
          throw new Error('No actual matching hidden request was admitted.');
        }
        const request = admitted.value;
        const choices = await readSavedChoices(context);
        // A legacy unpinned PG semantic caller cannot stand in for native saved-plan inference.
        expect(request.payload.inferencePlan).toEqual(choices.nativeLocalSelection);
        const before = await observe.diagnostics();
        expect(before.embeddingHost.pendingRequestCount).toBe(1);
        const terminalBefore = await observe.terminals();
        expect(
          terminalBefore.some(
            (event) =>
              event.value?.requestId === request.requestId &&
              event.value.runtimeId === request.runtimeId
          )
        ).toBe(false);
        const running = panel
          .getByTestId('activity-step-row')
          .and(panel.locator('[title="brainstrike.queryEmbeddingSpace"][data-state="running"]'));
        await expect(running).toHaveCount(1);
        const stopStartedAt = Date.now();
        const [response] = await Promise.all([
          context.window.waitForResponse(
            (value) =>
              new URL(value.url()).pathname === '/assistant/cancel' &&
              value.request().method() === 'POST'
          ),
          panel.getByRole('button', { exact: true, name: 'Stop' }).click(),
        ]);
        const acknowledgedAt = Date.now();
        const stopRequest: unknown = response.request().postDataJSON();
        if (
          !stopRequest ||
          typeof stopRequest !== 'object' ||
          typeof Reflect.get(stopRequest, 'runId') !== 'string'
        ) {
          throw new Error('Stop provided no actual run ID.');
        }
        const runId = Reflect.get(stopRequest, 'runId') as string;
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ accepted: true, runId });
        const events = await observe.events();
        expect(
          events.some(
            (event) =>
              event.kind === 'cancel' &&
              event.value.requestId === request.requestId &&
              event.value.runtimeId === request.runtimeId
          )
        ).toBe(true);
        const terminal = await observe.terminals();
        const matching = terminal.filter(
          (event) =>
            event.value?.requestId === request.requestId &&
            event.value.runtimeId === request.runtimeId
        );
        const joined =
          matching.some(
            (event) =>
              event.value?.type === 'error' &&
              event.value.payload.code === QUERY_CANCELED_CODE &&
              event.at >= stopStartedAt &&
              event.at <= acknowledgedAt
          ) ||
          terminal.some(
            (event) =>
              event.kind === 'destroyed' && event.at >= stopStartedAt && event.at <= acknowledgedAt
          );
        expect(
          joined,
          'Stop acknowledgement requires actual terminal cancellation or physical host retirement'
        ).toBe(true);
        expect(matching.some((event) => event.value?.type === 'result')).toBe(false);
        const after = await observe.diagnostics();
        expect(after.embeddingHost.pendingRequestCount).toBe(0);
        const durable = await context.window.evaluate(async (runId) => {
          const query = (window as unknown as PublicBridges).electronAPI?.db.query;
          if (!query) {
            throw new Error('Durable run bridge unavailable.');
          }
          return (
            await query('SELECT status FROM brainstrike_assistant_thread_runs WHERE id=$1', [runId])
          ).rows;
        }, runId);
        expect(durable).toEqual([{ status: 'cancelled' }]);
        await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
        await expect(
          panel
            .getByTestId('activity-step-row')
            .and(panel.locator('[title="brainstrike.queryEmbeddingSpace"]'))
            .last()
        ).toHaveAttribute('data-state', 'cancelled');
        await session.record('semantic-physical-stop', {
          acknowledgedAt,
          admitted,
          after,
          before,
          durable,
          events,
          runId,
          stopStartedAt,
          terminal,
          terminalBefore,
        });
        provider.setScript({
          finalText: 'M2 qualification tools completed',
          toolCallStages: [
            [{ arguments: { toolName: 'brainstrike_queryEmbeddingSpace' }, name: 'load_tool' }],
            [
              {
                arguments: { embeddingSetId: collectionId, query: 'DisposerStack' },
                name: 'brainstrike_queryEmbeddingSpace',
              },
            ],
          ],
        });
        await panel
          .getByRole('textbox', { name: 'Message input' })
          .fill('Run the fresh same-profile semantic recovery query.');
        await panel.getByRole('button', { exact: true, name: 'Send' }).click();
        await expect(
          panel.getByText('M2 qualification tools completed', { exact: true })
        ).toBeVisible({ timeout: 90_000 });
        const final = await observe.terminals();
        expect(
          final.some(
            (event) =>
              event.value?.requestId === request.requestId &&
              event.value.runtimeId === request.runtimeId &&
              event.value.type === 'result'
          )
        ).toBe(false);
        expect(
          final.some(
            (event) => event.value?.type === 'result' && event.value.requestId !== request.requestId
          )
        ).toBe(true);
        expect(await readSavedChoices(context)).toEqual(choices);
        await session.record('fresh-semantic-recovery', {
          choices: await readSavedChoices(context),
          events: await observe.events(),
          terminal: final,
        });
      } finally {
        await session.record('semantic-observation-final', {
          events: await observe.events(),
          terminal: await observe.terminals(),
        });
        await observe.close();
      }
    },
    async (context, session) => {
      collectionId = (await readSavedChoices(context)).managedCollectionId;
      const pgChunks = await context.window.evaluate(async (id) => {
        const query = (window as unknown as PublicBridges).electronAPI?.db.query;
        if (!query) {
          throw new Error('Canonical catalog bridge unavailable.');
        }
        return (
          await query<{ count: number }>(
            'SELECT count(*)::int AS count FROM file_chunks WHERE file_record_id IN (SELECT id FROM file_records WHERE embedding_set_id=$1)',
            [id]
          )
        ).rows;
      }, collectionId);
      expect(pgChunks).toEqual([{ count: 0 }]);
      await session.record('semantic-native-only-input', {
        collectionId,
        pgChunks,
        snapshot: await readNativeSnapshot(context),
      });
      observation = await observeSemanticQuery(context);
      expect((await observation.diagnostics()).embeddingHost.pendingRequestCount).toBe(0);
    }
  );
});
