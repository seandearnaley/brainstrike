import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

const FACT = '- Favourite colour: teal';

const streaming = (request: ModelProviderRequest): boolean =>
  (request.requestBody as { stream?: unknown }).stream === true;

/**
 * Working memory on a host thread: the model updates it through Mastra's own
 * `updateWorkingMemory` tool, and the next turn's request carries the update.
 */
test('a host thread updates working memory through the canonical tool and the next turn carries it', async ({
  modelProvider,
  window,
}) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript((request) => {
    if (!streaming(request)) {
      return { finalText: 'Colour preference' };
    }
    return JSON.stringify(request.messages).includes('What is my favourite colour?')
      ? { finalText: 'Your favourite colour is teal.' }
      : {
          finalText: 'Noted your favourite colour.',
          toolCall: { arguments: { memory: `# User facts\n${FACT}` }, name: 'updateWorkingMemory' },
        };
  });
  await ensureAssistantShellVisible(window);
  const input = window.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  const send = async (text: string, reply: string): Promise<void> => {
    await input.fill(text);
    await window.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(window.getByText(reply).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
  };
  await send('My favourite colour is teal.', 'Noted your favourite colour.');
  await send('What is my favourite colour?', 'Your favourite colour is teal.');

  const turns = modelProvider.requests().filter(streaming);
  expect(turns[0]?.toolNames).toContain('updateWorkingMemory');
  const last = turns.at(-1);
  expect(JSON.stringify(last?.messages)).toContain('What is my favourite colour?');
  // Mastra presents the updated working memory in the next turn's instructions.
  expect(JSON.stringify(last?.requestBody)).toContain('Favourite colour: teal');
  expect(modelProvider.refusals()).toEqual([]);
});
