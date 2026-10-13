import { rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { IndexSearchCapability } from '../../../../packages/indexing-contract/src/indexer-client';
import { HomePage } from '../../e2e/page-objects/home-page';
import { SettingsPage } from '../../e2e/page-objects/settings-page';
import { configureAssistantProvider } from '../../e2e/utils/assistant-mock';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import { writeIndexBuildCorpus } from '../../e2e/utils/index-build-corpus';
import { ensureAssistantShellVisible } from '../../e2e/utils/layout-helpers';
import { startModelProviderShim } from '../../e2e/utils/model-provider-shim';
import { createCandidateSession } from './candidate';
import { readSavedChoices } from './native-settings';
import { readDelegatedResetState, seedDelegatedResetState } from './precious-state';
import type { PublicBridges } from './public-bridges';
import { waitForScopes } from './scoped-acceptance';
import { assertActualVectorWorker, configureVectorProfile } from './vector-profile';

interface ChatRow {
  readonly content: unknown;
  readonly id: string;
  readonly role: string;
  readonly threadId: string;
}

interface ChatRun {
  readonly completedAt: unknown;
  readonly id: string;
  readonly status: string;
  readonly threadId: string;
  readonly turnMessageId: string;
}

async function chatRun(context: ElectronAppContext, turn: ChatRow): Promise<ChatRun[]> {
  return await context.window.evaluate(async ({ id, threadId }) => {
    const query = (window as unknown as PublicBridges).electronAPI?.db.query;
    if (!query) {
      throw new Error('Canonical run persistence bridge is unavailable.');
    }
    return (
      await query<ChatRun>(
        `SELECT id, thread_id AS "threadId", turn_message_id AS "turnMessageId",
                status, completed_at AS "completedAt"
         FROM brainstrike_assistant_thread_runs
         WHERE thread_id = $1 AND turn_message_id = $2`,
        [threadId, id]
      )
    ).rows;
  }, turn);
}

async function chatRows(context: ElectronAppContext): Promise<ChatRow[]> {
  return await context.window.evaluate(async () => {
    const query = (window as unknown as PublicBridges).electronAPI?.db.query;
    if (!query) {
      throw new Error('Canonical chat persistence bridge is unavailable.');
    }
    return (
      await query<ChatRow>(
        `SELECT id, thread_id AS "threadId", role, content FROM mastra_messages
         WHERE content::text LIKE $1 ORDER BY id`,
        ['%M2 rebuild control%']
      )
    ).rows;
  });
}

async function catalog(context: ElectronAppContext): Promise<unknown> {
  return await context.window.evaluate(async () => {
    const query = (window as unknown as PublicBridges).electronAPI?.db.query;
    if (!query) {
      throw new Error('Canonical catalog bridge is unavailable.');
    }
    return {
      collections: (
        await query(
          'SELECT id,model_key,model_id,dimensions,distance,name,system_role FROM embedding_sets ORDER BY id'
        )
      ).rows,
      files: (
        await query(
          'SELECT id,name,path,size,content_hash,embedding_set_id,root_id,content FROM file_records ORDER BY id'
        )
      ).rows,
    };
  });
}

async function status(
  context: ElectronAppContext
): Promise<Awaited<ReturnType<IndexSearchCapability['status']>>> {
  return await context.window.evaluate(async () => {
    const index = (window as unknown as PublicBridges).__brainstrikeTestHooks__?.indexSearch;
    if (!index) {
      throw new Error('Canonical native status bridge is unavailable.');
    }
    return await index.status();
  });
}

function incompleteStore(
  value: Awaited<ReturnType<IndexSearchCapability['status']>>,
  oldStore: string
): boolean {
  return (
    value.kind === 'ready' &&
    value.storeId !== oldStore &&
    value.rootReadiness.length === 1 &&
    value.rootReadiness[0]?.scanComplete === false &&
    value.collectionReadiness?.length === 1 &&
    value.collectionReadiness[0]?.scanComplete === false
  );
}

test('visible real VECTOR rebuild permits chat before completion and preserves chat/catalog', async () => {
  test.setTimeout(1_200_000);
  const session = await createCandidateSession('rebuild-chat');
  // Reuse the established 1000-file/seed1925 corpus; no new stress shape or timing probe.
  const corpus = writeIndexBuildCorpus({ files: 1000, seed: 1925 });
  const provider = await startModelProviderShim({
    finalText: 'M2 rebuild control before reply',
  });
  try {
    await session.record('corpus', corpus);
    const context = await session.launch({
      ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: corpus.rootPath,
      ['BRAINSTRIKE_OPENROUTER_API_KEY']: 'test-key-m2-qualification',
      ['OPENROUTER_BASE_URL']: provider.baseUrl,
    });
    await configureVectorProfile(context);
    await context.window.getByTestId('select-root-button').click();
    const initial = await waitForScopes(context, {
      collection: corpus.files,
      mode: 'VECTOR',
      workspace: corpus.files,
    });
    if (initial.status.kind !== 'ready') {
      throw new Error('Initial canonical store is unavailable.');
    }
    const oldStoreId = initial.status.storeId;
    await session.record('initial-complete-vector-store', initial);
    await configureAssistantProvider(context.window, {
      apiKey: 'test-key-m2-qualification',
      compositeModelKey: 'openrouter::openai/gpt-5.4',
      provider: 'openrouter',
    });
    await ensureAssistantShellVisible(context.window);
    const panel = context.window.getByTestId('chat-panel');
    const input = panel.getByRole('textbox', { name: 'Message input' });
    const send = panel.getByRole('button', { exact: true, name: 'Send' });
    await input.fill('M2 rebuild control before request');
    await send.click();
    await expect(panel.getByText('M2 rebuild control before reply', { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await expect.poll(() => chatRows(context)).toHaveLength(2);
    const originalChat = await chatRows(context);
    expect(new Set(originalChat.map((row) => row.threadId)).size).toBe(1);
    const sentinels = await seedDelegatedResetState(context.window);
    const precious = await readDelegatedResetState(context.window, sentinels);
    const beforeCatalog = await catalog(context);
    const choices = await readSavedChoices(context);
    const home = new HomePage(context.window);
    await home.openSettings();
    const section = await new SettingsPage(context.window).openCategory(
      /Search & Indexing/i,
      'search-indexing'
    );
    provider.setScript({ finalText: 'M2 rebuild control during reply' });
    await section.getByRole('button', { exact: true, name: 'Rebuild search index' }).click();
    const busy = section.getByRole('button', { exact: true, name: 'Rebuilding search index…' });
    await expect(busy).toBeVisible();
    await expect(busy).toBeDisabled();
    await context.window.screenshot({
      path: path.join(session.runDir, 'visible-rebuild-busy.png'),
    });
    await expect.poll(async () => incompleteStore(await status(context), oldStoreId)).toBe(true);
    const beforeChat = await status(context);
    expect(incompleteStore(beforeChat, oldStoreId)).toBe(true);
    await session.record('visible-nonterminal-rebuild', {
      beforeChat,
      busyLabel: await busy.innerText(),
    });
    await home.leaveSettings();
    await input.fill('M2 rebuild control during request');
    // Check after filling too: an already-complete rebuild cannot qualify chat overlap.
    expect(incompleteStore(await status(context), oldStoreId)).toBe(true);
    await send.click();
    await expect(panel.getByText('M2 rebuild control during reply', { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await expect.poll(() => chatRows(context)).toHaveLength(4);
    const duringChat = await chatRows(context);
    const newRows = duringChat.filter((row) => !originalChat.some((old) => old.id === row.id));
    expect(newRows).toHaveLength(2);
    const duringUser = newRows.find((row) => row.role === 'user');
    const duringAssistant = newRows.find((row) => row.role === 'assistant');
    if (!(duringUser && duringAssistant)) {
      throw new Error('Second chat turn has not persisted its user and assistant messages.');
    }
    expect(JSON.stringify(duringUser.content)).toContain('M2 rebuild control during request');
    expect(JSON.stringify(duringAssistant.content)).toContain('M2 rebuild control during reply');
    expect(duringUser.threadId).toBe(originalChat[0]?.threadId);
    expect(duringAssistant.threadId).toBe(duringUser.threadId);
    // Fence this exact turn's durable success; streamed text can precede its terminal write.
    await expect
      .poll(async () => {
        const runs = await chatRun(context, duringUser);
        const run = runs[0];
        return (
          runs.length === 1 &&
          run?.status === 'completed' &&
          run.completedAt !== null &&
          run.completedAt !== undefined
        );
      })
      .toBe(true);
    await expect(send).toBeVisible();
    await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
    const completedRuns = await chatRun(context, duringUser);
    const afterChat = await status(context);
    expect(incompleteStore(afterChat, oldStoreId)).toBe(true);
    if (beforeChat.kind !== 'ready' || afterChat.kind !== 'ready') {
      throw new Error('Chat overlap lost the actual rebuilding store.');
    }
    expect(afterChat.storeId).toBe(beforeChat.storeId);
    await session.record('chat-completed-before-rebuild', {
      afterChat,
      completedRuns,
      duringChat,
      transcript: provider.transcript(),
    });
    await context.window.screenshot({ path: path.join(session.runDir, 'chat-during-rebuild.png') });
    const rebuilt = await waitForScopes(context, {
      collection: corpus.files,
      mode: 'VECTOR',
      workspace: corpus.files,
    });
    assertActualVectorWorker(rebuilt);
    expect(rebuilt.status.kind === 'ready' && rebuilt.status.storeId).toBe(afterChat.storeId);
    await expect.poll(() => chatRows(context)).toHaveLength(4);
    const finalChat = await chatRows(context);
    for (const row of originalChat) {
      expect(finalChat.find((value) => value.id === row.id)).toEqual(row);
    }
    expect(new Set(finalChat.map((row) => row.threadId)).size).toBe(1);
    expect(await readSavedChoices(context)).toEqual(choices);
    expect(await catalog(context)).toEqual(beforeCatalog);
    expect(await readDelegatedResetState(context.window, sentinels)).toEqual(precious);
    await home.openSettings();
    const completeSection = await new SettingsPage(context.window).openCategory(
      /Search & Indexing/i,
      'search-indexing'
    );
    await expect(
      completeSection.getByRole('button', { exact: true, name: 'Rebuild search index' })
    ).toBeEnabled();
    await expect(completeSection.getByRole('alert')).toHaveCount(0);
    await session.record('completed-rebuild-preserves-chat-and-catalog', {
      choices,
      finalChat,
      originalChat,
      precious,
      snapshot: rebuilt,
    });
    await context.window.screenshot({ path: path.join(session.runDir, 'rebuild-completed.png') });
  } catch (error) {
    await session.record('failure', { message: String(error), transcript: provider.transcript() });
    throw error;
  } finally {
    try {
      await session.close();
    } finally {
      await provider.close();
      await session.record('provider-closed', { requestCount: provider.requestCount() });
    }
    // Remove only this generator-owned source root, after actual app owners have exited.
    await rm(corpus.rootPath, { recursive: true });
    await session.record('owned-corpus-removed', { rootPath: corpus.rootPath });
  }
});
