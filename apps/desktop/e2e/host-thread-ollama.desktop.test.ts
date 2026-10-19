/**
 * A host thread on a locally discovered Ollama model, end to end in the
 * mounted app. A loopback server replays exchanges recorded on 2026-10-18
 * from Ollama 0.40.5 (`e2e/recordings/ollama-0.40.5/<model>`): the discovery
 * responses the picker reads for that one model (`/api/tags`, `/api/show`,
 * `/v1/models`, `/api/version`) and one streamed reply on the native route
 * the provider calls (`POST /api/chat`). `/api/show` keeps the recorded
 * capabilities, details and `model_info` context keys, without the license,
 * modelfile and tokenizer. A non-streamed request (the thread title) gets the
 * recorded reply as one JSON message.
 *
 * BST-754: each run is admitted at the window its model reports, capped at
 * 32,768, and asks Ollama to allocate exactly that (`num_ctx`); while
 * recording, `ollama ps` showed each model loaded at it. qwen3:14b reports
 * 40,960 (capped) and thinks. phi4 reports 16,384, which cannot hold the run's
 * own instructions and tools, so its run refuses visibly, naming the numbers.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readCommittedRuns } from './utils/agent-host-log';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const REPLY = 'host ollama run ok';
// Playwright runs from apps/desktop.
const RECORDINGS = path.resolve('e2e', 'recordings', 'ollama-0.40.5');

interface ReplayServer {
  /** Each `/api/chat` request body the provider sent. */
  readonly chats: readonly Record<string, unknown>[];
  readonly origin: string;
  stop(): Promise<void>;
}

/** The recorded stream folded into the one message a non-streamed request gets. */
function nonStreamedReply(ndjson: string): string {
  const lines = ndjson
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { message: { content: string } });
  const last = lines.at(-1);
  return JSON.stringify({
    ...last,
    message: {
      content: lines.map((line) => line.message.content).join(''),
      role: 'assistant',
    },
  });
}

async function startOllamaReplay(recording: string): Promise<ReplayServer> {
  const recorded = (name: string): string =>
    readFileSync(path.join(RECORDINGS, recording, name), 'utf8');
  const json: Record<string, string> = {
    'GET /api/tags': recorded('api-tags.json'),
    'GET /api/version': recorded('api-version.json'),
    'GET /v1/models': recorded('v1-models.json'),
    'POST /api/show': recorded('api-show.json'),
  };
  const chats: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    const route = `${request.method} ${(request.url ?? '').split('?')[0]}`;
    const received: Buffer[] = [];
    request.on('data', (chunk: Buffer) => received.push(chunk));
    request.on('end', () => {
      if (route === 'POST /api/chat') {
        const chat = JSON.parse(Buffer.concat(received).toString('utf8')) as Record<
          string,
          unknown
        >;
        chats.push(chat);
        const stream = recorded('api-chat.ndjson');
        response.writeHead(200, {
          'content-type': chat['stream'] === true ? 'application/x-ndjson' : 'application/json',
        });
        response.end(chat['stream'] === true ? stream : nonStreamedReply(stream));
        return;
      }
      const body = json[route];
      if (body === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: `not recorded: ${route}` }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    chats,
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function pointOllamaAt(page: Page, origin: string, openSettings: () => Promise<void>) {
  await openSettings();
  await page
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { name: /Local Runtimes/i })
    .click();
  await page.getByTestId('local-runtime-url-input-ollama').fill(origin);
  await page.getByTestId('local-runtime-url-save-ollama').click();
  const card = page
    .getByRole('heading', { exact: true, name: 'Ollama' })
    .locator('..')
    .locator('..');
  await expect(card).toContainText(/Available/i, { timeout: 15_000 });
}

/** Point the app at the replay, select the model, and send one message. */
async function sendOnOllama(
  page: Page,
  openSettings: () => Promise<void>,
  ollama: ReplayServer,
  model: string
) {
  await pointOllamaAt(page, ollama.origin, openSettings);
  await page.evaluate((selected) => {
    const hooks = (
      globalThis as unknown as {
        __brainstrikeTestHooks__?: { setAssistantModel: (compositeKey: string) => void };
      }
    ).__brainstrikeTestHooks__;
    if (!hooks) {
      throw new Error('Brainstrike desktop test hooks are unavailable.');
    }
    hooks.setAssistantModel(`ollama::${selected}`);
  }, model);
  await page.keyboard.press('Escape');
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill('Say the four words.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  return region;
}

test('a host thread on a discovered Ollama model sends, renders the reply and commits the run', async ({
  electron,
  homePage,
  window: page,
}) => {
  test.setTimeout(300_000);
  const ollama = await startOllamaReplay('qwen3-14b');
  try {
    const region = await sendOnOllama(page, () => homePage.openSettings(), ollama, 'qwen3:14b');
    await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });

    // Every call, the run and its title alike, went to the native route at
    // the admitted window: 40,960 reported, capped at 32,768.
    expect(ollama.chats.map((chat) => chat['stream'])).toContain(true);
    for (const chat of ollama.chats) {
      expect(chat).toMatchObject({
        model: 'qwen3:14b',
        options: { num_ctx: 32_768 },
        think: true,
      });
    }
    const tabId =
      (await page
        .getByRole('tablist', { name: 'Open assistant threads' })
        .getByRole('tab', { selected: true })
        .getAttribute('id')) ?? '';
    const [run] = await readCommittedRuns(
      electron.getUserDataDir(),
      tabId.replace('assistant-thread-tab-', '')
    );
    expect(run?.status).toBe('completed');
  } finally {
    await electron.dispose();
    await ollama.stop();
  }
});

test('a run on an Ollama model too small for its own instructions refuses, naming the numbers (BST-754)', async ({
  electron,
  homePage,
  window: page,
}) => {
  test.setTimeout(300_000);
  const ollama = await startOllamaReplay('phi4');
  try {
    const region = await sendOnOllama(page, () => homePage.openSettings(), ollama, 'phi4:latest');
    await expect(
      region.getByText(
        /This request needs about [\d,]+ input tokens, but the selected model accepts [\d,]+\./u
      )
    ).toBeVisible({ timeout: 90_000 });
    await expect(region.getByText(/Choose a model with a larger context window/u)).toBeVisible();
    // The run never streamed; only its title asked, at phi4's own window.
    expect(ollama.chats.some((chat) => chat['stream'] === true)).toBe(false);
    for (const chat of ollama.chats) {
      expect(chat).toMatchObject({ options: { num_ctx: 16_384 }, think: false });
    }
  } finally {
    await electron.dispose();
    await ollama.stop();
  }
});
