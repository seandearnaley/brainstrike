import { createHash, randomUUID } from 'node:crypto';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Response, test } from '@playwright/test';
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
} from '../../e2e/utils/model-provider-shim';
import type { EMBEDDING_HOST_QUERY_CANCELED_CODE } from '../../src/embedding-host-shared';
import { type ArtifactFlow, createArtifactFlow } from './artifact-flow';
import {
  type CandidateSession,
  createCandidateSession,
  observeNativeSnapshot,
  readNativeSnapshot,
  waitForTextIndex,
} from './candidate';
import { waitForCurrentObservation } from './coverage-observation';
import { nativeBuildComplete } from './native-benchmark';
import { configureNativeText, readSavedChoices, type SavedNativeChoices } from './native-settings';
import { startCapturingProvider } from './provider-capture';
import type { PublicBridges } from './public-bridges';
import { observeSemanticQuery, type SemanticObservation } from './semantic-stop';
import { assertActualVectorWorker, configureVectorProfile } from './vector-profile';

// runTools indexes the three committed source files. Artifact preparation
// changes an existing source; it adds no fourth file.
const TOOL_CORPUS_FILE_COUNT = 3;
// Compile-time pin to the public contract without loading the application's inference modules.
const QUERY_CANCELED_CODE: typeof EMBEDDING_HOST_QUERY_CANCELED_CODE =
  'EMBEDDING_HOST_QUERY_CANCELED';

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
      const complete = await waitForCurrentObservation(
        () => observeNativeSnapshot(context),
        (read) =>
          expect
            .poll(
              async () => {
                const value = await read();
                return value !== null && nativeBuildComplete(value.status, value.coverage, scope);
              },
              { timeout: 480_000 }
            )
            .toBe(true)
      );
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
  const term = `M2 semantic physical stop DisposerStack ${randomUUID()}`;
  let collectionId: string | undefined;
  let observation: SemanticObservation | undefined;
  let choices: SavedNativeChoices | undefined;
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
      if (!(observation && choices)) {
        throw new Error('Semantic physical observation is not armed.');
      }
      const observe = observation;
      const panel = context.window.getByTestId('chat-panel');
      let stopResponse:
        | Promise<{ response: Response; at: number } | { error: unknown }>
        | undefined;
      let stopClick: Promise<undefined | { error: unknown }> | undefined;
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
        await expect.poll(() => observe.submission(), { intervals: [10] }).not.toBeNull();
        const submission = await observe.submission();
        expect(submission?.releasedAt).toBeNull();
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
        let releaseRequested = false;
        stopResponse = context.window
          .waitForResponse(
            (value) =>
              new URL(value.url()).pathname === '/assistant/cancel' &&
              value.request().method() === 'POST'
          )
          .then((response) => {
            if (!releaseRequested) {
              throw new Error('Stop acknowledged while the real worker submission was held.');
            }
            return { at: Date.now(), response };
          })
          .catch((error: unknown) => ({ error }));
        const posted = context.window.waitForRequest(
          (value) =>
            new URL(value.url()).pathname === '/assistant/cancel' && value.method() === 'POST'
        );
        stopClick = panel
          .getByRole('button', { exact: true, name: 'Stop' })
          .click()
          .then(() => undefined)
          .catch((error: unknown) => ({ error }));
        const stopRequest: unknown = (await posted).postDataJSON();
        if (
          !stopRequest ||
          typeof stopRequest !== 'object' ||
          typeof Reflect.get(stopRequest, 'runId') !== 'string'
        ) {
          throw new Error('Stop provided no actual run ID.');
        }
        const runId = Reflect.get(stopRequest, 'runId') as string;
        await expect
          .poll(
            async () =>
              (await observe.events()).some(
                (event) =>
                  event.kind === 'cancel' &&
                  event.value.requestId === request.requestId &&
                  event.value.runtimeId === request.runtimeId
              ),
            { intervals: [10] }
          )
          .toBe(true);
        const held = await observe.submission();
        const duringCancel = await observe.diagnostics();
        const terminalWhileHeld = await observe.terminals();
        await session.record('semantic-cancel-before-worker-release', {
          admitted,
          duringCancel,
          held,
          runId,
          submission,
          terminalWhileHeld,
        });
        expect(held?.releasedAt).toBeNull();
        expect(duringCancel.embeddingHost.pendingRequestCount).toBe(1);
        expect(
          terminalWhileHeld.some(
            (event) =>
              event.value?.requestId === request.requestId &&
              event.value.runtimeId === request.runtimeId
          )
        ).toBe(false);
        releaseRequested = true;
        await observe.releaseSubmission();
        await session.record('semantic-worker-submission-released', await observe.submission());
        const outcome = await stopResponse;
        if ('error' in outcome) {
          throw outcome.error;
        }
        const click = await stopClick;
        if (click && 'error' in click) {
          throw click.error;
        }
        const { response, at: acknowledgedAt } = outcome;
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
          duringCancel,
          events,
          held,
          runId,
          stopStartedAt,
          submission,
          terminal,
          terminalBefore,
          terminalWhileHeld,
        });
        await observe.restoreSubmission();
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
        // Restore and release before joining Stop or sending any recovery query.
        await observe.restoreSubmission();
        await Promise.all([stopResponse, stopClick]);
        await session.record('semantic-observation-final', {
          events: await observe.events(),
          terminal: await observe.terminals(),
        });
        await observe.close();
      }
    },
    async (context, session) => {
      choices = await readSavedChoices(context);
      collectionId = choices.managedCollectionId;
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
      if (!choices.nativeLocalSelection) {
        throw new Error('Saved pinned native inference plan is unavailable.');
      }
      observation = await observeSemanticQuery(context, {
        plan: choices.nativeLocalSelection,
        // MiniLM's catalog row states no prompts, so the worker embeds the raw query (BST-1993).
        workerText: term,
      });
      expect((await observation.diagnostics()).embeddingHost.pendingRequestCount).toBe(0);
    }
  );
});
