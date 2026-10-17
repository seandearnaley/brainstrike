import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  decodeToolOutputArtifactContent,
  isToolOutputArtifactPage,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import { expect, test } from './fixtures/electron-fixture';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';

const MODEL = 'anthropic/claude-sonnet-4.6';
const API_KEY = 'test-key-effect-search-artifact';
const REPLY = 'Search and artifact continuation completed.';
const GREP = 'brainstrike_grepSearch';
const ARTIFACT = 'brainstrike_readToolOutputArtifact';
test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

test('Effect search and artifact inputs execute through the app and survive reload', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-effect-search-')));
  try {
    // Grep caps characters; multibyte evidence still exceeds the artifact byte ceiling.
    await writeFile(
      path.join(root, 'evidence.txt'),
      Array.from({ length: 200 }, (_, index) => `E01_MARKER ${index} ${'証拠'.repeat(240)}`).join(
        '\n'
      )
    );
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'effect-search-artifact-root',
      rootId: randomUUID(),
    });
    await configureAssistantProvider(page, {
      apiKey: API_KEY,
      compositeModelKey: `openrouter::${MODEL}`,
      provider: 'openrouter',
    });
    await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
    modelProvider.setScript(({ messages, requestBody }) => {
      if (
        !(
          requestBody &&
          typeof requestBody === 'object' &&
          'stream' in requestBody &&
          requestBody.stream === true
        )
      ) {
        return { finalText: 'Effect schema qualification' };
      }
      const cursor = /bsto1\.[A-Za-z0-9_-]+/u.exec(JSON.stringify(messages))?.[0];
      const completed = messages.filter(
        (message) =>
          message && typeof message === 'object' && 'role' in message && message.role === 'tool'
      ).length;
      if (completed >= 2 && !cursor) {
        throw new Error('The search output did not provide an artifact continuation.');
      }
      return {
        finalText: REPLY,
        toolCallStages: [
          [{ arguments: { toolNames: [GREP, ARTIFACT] }, name: 'load_tool' }],
          [
            {
              arguments: {
                filePaths: ['evidence.txt'],
                maxResults: 200,
                outputMode: 'content',
                pattern: 'E01_MARKER',
              },
              name: GREP,
            },
          ],
          [
            {
              arguments: {
                cursor: cursor ?? 'missing-artifact-cursor',
                maxBytes: 8000,
              },
              name: ARTIFACT,
            },
          ],
        ],
      };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region
      .getByRole('textbox', { name: 'Message input' })
      .fill('Search the evidence and read its artifact continuation.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(region.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 90_000 });
    const tree = await readHostThreadTree(electron.getUserDataDir());
    const rows = tree.flatMap((thread) => thread.rows);
    expect(JSON.stringify(rows)).toContain('E01_MARKER');
    await test
      .info()
      .attach('host-log', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
    await test.info().attach('provider-requests', {
      body: JSON.stringify(modelProvider.requests(), null, 2),
      contentType: 'application/json',
    });
    const starts = rows.flatMap(({ event }) => (event.type === 'effect.started' ? [event] : []));
    const reader = starts.find((event) => event.toolId === ARTIFACT);
    expect(reader).toBeDefined();
    const finished = rows.flatMap(({ event }) => (event.type === 'effect.finished' ? [event] : []));
    const output = finished.find((event) => event.toolCallId === reader?.toolCallId)?.output;
    expect(isToolOutputArtifactPage(output)).toBe(true);
    if (!isToolOutputArtifactPage(output)) {
      throw new Error('The artifact tool did not return a page.');
    }
    expect(decodeToolOutputArtifactContent(output.content, output.contentEncoding)).toContain(
      'E01_MARKER'
    );
    expect(output.endByte).toBeGreaterThan(output.offsetByte);
    // The provider must receive an actual reader result, not merely a tool call.
    const wire = JSON.stringify(modelProvider.requests());
    expect(wire).toContain('bsto1.');
    expect(wire).not.toContain('missing-artifact-cursor');
    await page.screenshot({ path: test.info().outputPath('search-artifact.png') });
    await reloadRenderer(page, 'effect-search-artifact-reload');
    await ensureAssistantShellVisible(page);
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await electron.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
