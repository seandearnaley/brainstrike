/**
 * Provider egress boundary proof (BST-1931, #3543 ruling 6052594658).
 *
 * Incident: on M3 committed threads run in the agent host, so the renderer
 * `setupAssistantMock` never sees them, and desktop E2E sends reached the real
 * api.openai.com with the fixture key (smoke diagnosis D2,
 * `delegated-workspace-reload`). A deliberately unscripted provider request must
 * be refused before it leaves loopback.
 *
 * The stand-in for a real provider destination is a plain loopback HTTP
 * sentinel (deliberately NOT the canonical model-provider shim), configured the
 * way an inherited shell value arrives: through the provider's base-URL knob in
 * the worker environment. Nothing here can contact a real endpoint.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

const SENTINEL_MESSAGE =
  'Loopback sentinel reached: this provider request was not refused by the E2E egress boundary.';
const RUN_SETTLED = /Loopback sentinel reached|E2E egress boundary refused/;

interface SentinelRequest {
  readonly method: string;
  readonly path: string;
}

interface LoopbackSentinel {
  close(): Promise<void>;
  readonly origin: string;
  readonly requests: SentinelRequest[];
}

async function startLoopbackSentinel(): Promise<LoopbackSentinel> {
  const requests: SentinelRequest[] = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method ?? '', path: request.url ?? '' });
    request.resume();
    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    // Shaped for every provider SDK error parser: OpenAI/OpenRouter read
    // `error.message`; Anthropic reads `{ type: 'error', error }`.
    response.end(
      JSON.stringify({
        error: { code: 'sentinel_reached', message: SENTINEL_MESSAGE, param: null, type: 'error' },
        type: 'error',
      })
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    origin: `http://127.0.0.1:${port}`,
    requests,
  };
}

/** Sets worker environment for the next launch and restores it afterwards. */
async function withWorkerEnvironment<T>(
  values: Readonly<Record<string, string>>,
  body: () => Promise<T>
): Promise<T> {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function enableCatalogModel(page: Page, provider: string, model: string): Promise<unknown> {
  // Renderer selection alone does not enable the catalog row Main admits
  // (precedent: mcp-packaged-core.desktop.test.ts).
  return await page.evaluate(
    async ([providerId, modelId]) => {
      const db = window.electronAPI?.db;
      if (!db) {
        throw new Error('The ordinary desktop catalog DB bridge is unavailable');
      }
      await db.query('UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
        modelId,
        providerId,
      ]);
      const after = await db.query(
        'SELECT id, provider_id AS "providerId", is_enabled AS "isEnabled" FROM models WHERE id = $1 AND provider_id = $2',
        [modelId, providerId]
      );
      return after.rows;
    },
    [provider, model] as const
  );
}

async function sendUnscriptedPrompt(page: Page, provider: string, model: string): Promise<void> {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(page);
  await configureAssistantProvider(page, { compositeModelKey: `${provider}::${model}`, provider });
  expect(await enableCatalogModel(page, provider, model)).toEqual([
    { id: model, isEnabled: true, providerId: provider },
  ]);
  await ensureMockWorkspaceOpen(page);
  await ensureAssistantShellVisible(page);
  const assistant = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = assistant.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill('Unscripted provider request for the egress boundary proof.');
  await assistant.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(assistant.getByText(RUN_SETTLED).first()).toBeVisible({ timeout: 60_000 });
}

// Host and Main read provider credentials from the environment (test-mode
// `secrets.saveKey` writes only the renderer IPC's in-memory map), so each case
// names its fixture credential there: the harness already sets the OpenAI one.
const REDIRECTABLE_CASES = [
  {
    credentials: {},
    expectedRoute: 'POST /responses',
    knob: 'OPENAI_BASE_URL',
    model: 'gpt-5.2',
    provider: 'openai',
  },
  {
    credentials: { ['BRAINSTRIKE_ANTHROPIC_API_KEY']: 'e2e-fixture-not-a-credential' },
    expectedRoute: 'POST /messages',
    knob: 'ANTHROPIC_BASE_URL',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
  },
] as const;

test.describe('Provider egress boundary (desktop)', () => {
  for (const scenario of REDIRECTABLE_CASES) {
    test(`an unscripted ${scenario.provider} request configured through ${scenario.knob} never reaches its destination`, async ({
      electron,
    }, testInfo) => {
      test.setTimeout(180_000);
      const sentinel = await startLoopbackSentinel();
      try {
        const environment = { ...scenario.credentials, [scenario.knob]: sentinel.origin };
        await withWorkerEnvironment(environment, async () => {
          const page = await electron.ensureWindow();
          await sendUnscriptedPrompt(page, scenario.provider, scenario.model);
          await testInfo.attach('sentinel-requests', {
            body: JSON.stringify(sentinel.requests, null, 2),
            contentType: 'application/json',
          });
          expect(
            sentinel.requests,
            `${scenario.knob} must never route an unscripted request to the configured destination`
          ).toEqual([]);
          await expect(
            page
              .getByRole('region', { exact: true, name: 'Assistant' })
              .getByText(/E2E egress boundary refused an unscripted provider request/)
              .first()
          ).toBeVisible();
        });
      } finally {
        try {
          await electron.dispose();
        } finally {
          await sentinel.close();
        }
      }
    });
  }

  test('a credential for a provider with no redirect knob refuses the launch', async ({
    electron,
  }) => {
    await withWorkerEnvironment(
      { ['GOOGLE_GENERATIVE_AI_API_KEY']: 'e2e-sentinel-not-a-credential' },
      async () => {
        await expect(electron.ensureWindow()).rejects.toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
      }
    );
  });
});
