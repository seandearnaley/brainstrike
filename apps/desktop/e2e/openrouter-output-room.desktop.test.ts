import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

/**
 * BST-1810: OpenRouter's output setting is shared by every OpenRouter model,
 * and some routes publish a maximum output within the safety margin of their
 * window (MiniMax M3: 512,000 of 524,288). Two things go wrong:
 *   - The output control offered a route's whole published maximum, though a
 *     value past the window's room leaves no input budget.
 *   - A limit that fits one model (Kimi K3's 1,048,576 window) can follow the
 *     user to a model whose window cannot hold it. With that model's live
 *     details unavailable, the run budgets on its catalog row, and the
 *     renderer threw composing it.
 * The shim records no metadata for either model, so each lookup fails here
 * exactly as it does when OpenRouter is unreachable.
 */

const MODEL_PROVIDER_SHIM_API_KEY = 'test-key-e2e-output-room';
const KIMI = 'openrouter::moonshotai/kimi-k3';
const MINIMAX = 'openrouter::minimax/minimax-m3';

test.describe('OpenRouter output room (desktop, BST-1810)', () => {
  test('a shared output limit too large for the next model is named, not thrown', async ({
    electron,
  }, testInfo) => {
    const provider = await startModelProviderShim(() => ({ finalText: 'unused' }));
    const environment = {
      BRAINSTRIKE_OPENROUTER_API_KEY: MODEL_PROVIDER_SHIM_API_KEY,
      OPENROUTER_BASE_URL: provider.baseUrl,
    };
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]])
    );
    Object.assign(process.env, environment);
    try {
      const window = await electron.ensureWindow();
      await ensureMockWorkspaceOpen(window);
      await enableAssistantCatalogModel(window, MINIMAX);
      await enableAssistantCatalogModel(window, KIMI);
      await configureAssistantProvider(window, {
        apiKey: MODEL_PROVIDER_SHIM_API_KEY,
        compositeModelKey: KIMI,
        provider: 'openrouter',
      });
      await ensureAssistantShellVisible(window);
      const root = window.getByRole('region', { exact: true, name: 'Assistant' });

      // Kimi K3's room (996,146) is past its published maximum, which stays the bound.
      await root.getByRole('button', { name: 'Open assistant controls' }).click();
      const controls = window.getByRole('dialog', { name: 'Assistant controls' });
      await controls.getByText('Output & Limits', { exact: true }).click();
      await expect(controls.getByText(/Live metadata unavailable/)).toBeVisible();
      await controls.getByRole('switch', { name: 'Limit output tokens per step' }).click();
      const output = controls.getByRole('spinbutton', { name: 'Output token limit' });
      await expect(output).toHaveAttribute('max', '943718');
      await output.fill('600000');
      await output.press('Enter');
      await expect(controls.getByRole('alert')).toHaveCount(0);
      await window.keyboard.press('Escape');
      await expect(controls).toHaveCount(0);

      await configureAssistantProvider(window, {
        apiKey: MODEL_PROVIDER_SHIM_API_KEY,
        compositeModelKey: MINIMAX,
        provider: 'openrouter',
      });
      await expect(
        root.getByText(
          'Configured output limit 600,000 cannot fit within the OpenRouter built-in catalog context window 524,288 plus its safety margin.'
        )
      ).toBeVisible();
      await expect(root.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      await window.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath('openrouter-output-room.png'),
      });
      expect(
        provider
          .refusals()
          .map(({ reason, route }) => `${reason} ${route}`)
          .sort()
      ).toEqual([
        'unrecorded-model-metadata /model/minimax/minimax-m3',
        'unrecorded-model-metadata /model/moonshotai/kimi-k3',
      ]);
    } finally {
      await electron.dispose();
      await provider.close();
      for (const key of Object.keys(environment)) {
        const value = previous[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
