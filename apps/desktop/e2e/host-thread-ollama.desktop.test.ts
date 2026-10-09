/**
 * A host thread on a locally discovered Ollama model, end to end in the
 * mounted app. A loopback server replays an exchange recorded on 2026-10-08
 * from Ollama 0.32.14 with its smallest installed chat model
 * (`e2e/recordings/ollama-0.32.14`): the discovery responses the picker reads
 * for that one model (`/api/tags`, `/api/show`, `/v1/models`, `/api/version`)
 * and one streamed reply on the OpenAI-compatible route the provider calls
 * (`POST /v1/chat/completions`). `/api/show` keeps the recorded capabilities
 * and details, without the license and modelfile text.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readCommittedRuns } from './utils/agent-host-log';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const MODEL = 'lfm2.5-thinking:latest';
const REPLY = 'host ollama run ok';
// Playwright runs from apps/desktop.
const RECORDING = path.resolve('e2e', 'recordings', 'ollama-0.32.14');

interface ReplayServer {
  readonly origin: string;
  readonly requests: readonly string[];
  stop(): Promise<void>;
}

async function startOllamaReplay(): Promise<ReplayServer> {
  const recorded = (name: string): string => readFileSync(path.join(RECORDING, name), 'utf8');
  const json: Record<string, string> = {
    'GET /api/tags': recorded('api-tags.json'),
    'GET /api/version': recorded('api-version.json'),
    'GET /v1/models': recorded('v1-models.json'),
    'POST /api/show': recorded('api-show.json'),
  };
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const route = `${request.method} ${(request.url ?? '').split('?')[0]}`;
    requests.push(route);
    request.resume();
    request.on('end', () => {
      if (route === 'POST /v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(recorded('v1-chat-completions.sse'));
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
    origin: `http://127.0.0.1:${port}`,
    requests,
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

test('a host thread on a discovered Ollama model sends, renders the reply and commits the run', async ({
  electron,
  homePage,
  window: page,
}) => {
  test.setTimeout(300_000);
  const ollama = await startOllamaReplay();
  try {
    await pointOllamaAt(page, ollama.origin, () => homePage.openSettings());
    await page.evaluate((model) => {
      const hooks = (
        globalThis as unknown as {
          __brainstrikeTestHooks__?: { setAssistantModel: (compositeKey: string) => void };
        }
      ).__brainstrikeTestHooks__;
      if (!hooks) {
        throw new Error('Brainstrike desktop test hooks are unavailable.');
      }
      hooks.setAssistantModel(`ollama::${model}`);
    }, MODEL);
    await page.keyboard.press('Escape');

    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Say the four words.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });

    // The host's provider streamed from the replay, and the run committed.
    expect(ollama.requests).toContain('POST /v1/chat/completions');
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
