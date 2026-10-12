import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

// Plan mode admits only what reads and proposes a plan, so its run has no write tool.
const WRITE = 'brainstrike_writeWorkspaceFile';

/** Sends `marker` and returns the persona tools its first streamed provider request advertised. */
async function probePersonaTools(
  panel: Locator,
  modelProvider: ModelProviderShim,
  marker: string
): Promise<{ readonly agents: readonly string[]; readonly tools: readonly string[] }> {
  const before = modelProvider.requests().length;
  await panel.getByRole('textbox', { name: 'Message input' }).fill(marker);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText(`${marker} answered`, { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  const request = modelProvider
    .requests()
    .slice(before)
    .find(({ requestBody }) => (requestBody as { stream?: unknown }).stream === true);
  expect(request, `${marker} must reach the provider`).toBeDefined();
  const tools = request?.toolNames ?? [];
  return { agents: tools.filter((name) => name.startsWith('agent-')).sort(), tools };
}

/**
 * AT-20 (A26): a host thread advertises no persona in plan mode, and a persona
 * disabled in Settings drops only its own `agent-*` tool. (The local provider
 * omits all personas too; agent-host-delegation.test.ts pins it, since the E2E
 * provider is the scripted OpenRouter shim.)
 */
test('personas are omitted in plan mode and for a persona disabled in Settings', async ({
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript(({ messages, requestBody }) => {
    if ((requestBody as { stream?: unknown }).stream !== true) {
      return { finalText: 'Persona omission' };
    }
    const marker = /PERSONA_PROBE_\w+/u.exec(JSON.stringify(messages.at(-1)))?.[0] ?? 'unknown';
    return { finalText: `${marker} answered` };
  });
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  await expect(panel.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: E2E_TIMEOUTS.inputVisibility,
  });

  // Plan mode: the planning run is offered no edit tool and no persona.
  const toggle = panel.getByRole('button', { name: 'Toggle plan mode' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const planning = await probePersonaTools(panel, modelProvider, 'PERSONA_PROBE_PLAN');
  expect(planning.tools).not.toContain(WRITE);
  expect(planning.agents).toEqual([]);

  // Out of plan mode the same thread advertises every default persona.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const acting = await probePersonaTools(panel, modelProvider, 'PERSONA_PROBE_ACT');
  expect(acting.tools).toContain(WRITE);
  expect(acting.agents).toEqual(['agent-analyze', 'agent-explore', 'agent-worker']);

  // Disabling Explorer in Settings drops only `agent-explore` from the next run.
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Subagents/i, 'subagents');
  const explorer = window.getByTestId('subagent-persona-toggle-explore');
  await expect(explorer).toHaveAttribute('aria-checked', 'true');
  await explorer.click();
  await expect(explorer).toHaveAttribute('aria-checked', 'false');
  await ensureAssistantShellVisible(window);
  const withoutExplorer = await probePersonaTools(panel, modelProvider, 'PERSONA_PROBE_DISABLED');
  expect(withoutExplorer.agents).toEqual(['agent-analyze', 'agent-worker']);
  expect(modelProvider.refusals()).toEqual([]);
});
