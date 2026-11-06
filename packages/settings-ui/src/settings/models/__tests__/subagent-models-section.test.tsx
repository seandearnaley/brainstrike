import '@testing-library/jest-dom/vitest';
import { useAssistantSubagentPreferencesStore } from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { SubagentModelsSection } from '../subagent-models-section';

vi.mock('@brainstrike/app-state/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

// cmdk scrolls the active option into view; happy-dom has no layout.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const model = (providerId: string, id: string, name: string, isEnabled = true) => ({
  bestFor: null,
  capabilities: { streaming: true, type: 'llm' as const },
  description: null,
  icon: null,
  id,
  isEnabled,
  name,
  parameters: null,
  providerId,
  sortOrder: 1,
  tagline: null,
});

beforeEach(() => {
  useAssistantSubagentPreferencesStore.getState().resetToDefaults();
  useModelRegistryStore.setState({
    error: null,
    hasLoaded: true,
    isLoading: false,
    models: [
      model('openai', 'gpt-6-sol', 'GPT-6 Sol'),
      model('openrouter', 'anthropic/claude-opus-5.5', 'Claude Opus 5.5 (OpenRouter)'),
      model('openrouter', 'qwen/qwen-4-coder', 'Qwen 4 Coder (OpenRouter)', false),
    ],
    providers: [
      { icon: null, id: 'openai', isEnabled: true, name: 'OpenAI', sortOrder: 1 },
      { icon: null, id: 'openrouter', isEnabled: true, name: 'OpenRouter', sortOrder: 4 },
    ],
  });
});

it('adds an enabled model a delegation may name, shows it with its mark, and removes it', async () => {
  const user = userEvent.setup();
  render(<SubagentModelsSection />);
  const section = screen.getByTestId('subagent-models-section');
  expect(within(section).queryByRole('list')).not.toBeInTheDocument();

  await user.click(within(section).getByRole('button', { name: 'Add model' }));
  const menu = await screen.findByRole('dialog', { name: 'Add a model subagents may run on' });
  // Only enabled models are offered.
  expect(within(menu).queryByRole('option', { name: /Qwen/u })).not.toBeInTheDocument();
  await user.click(within(menu).getByRole('option', { name: /Claude Opus 5\.5/u }));

  expect(useAssistantSubagentPreferencesStore.getState().models).toEqual([
    'openrouter::anthropic/claude-opus-5.5',
  ]);
  const list = within(section).getByRole('list', { name: 'Models subagents may run on' });
  expect(within(list).getByRole('img', { name: 'Anthropic via OpenRouter' })).toBeInTheDocument();
  expect(within(list).getByText('Claude Opus 5.5 (OpenRouter)')).toBeInTheDocument();

  // A chosen model is not offered again.
  await user.click(within(section).getByRole('button', { name: 'Add model' }));
  const again = await screen.findByRole('dialog', { name: 'Add a model subagents may run on' });
  expect(within(again).queryByRole('option', { name: /Claude Opus/u })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');

  await user.click(
    within(list).getByRole('button', { name: 'Remove Claude Opus 5.5 (OpenRouter)' })
  );
  expect(useAssistantSubagentPreferencesStore.getState().models).toEqual([]);
});

it('offers only the models of providers with a key', async () => {
  const user = userEvent.setup();
  render(<SubagentModelsSection providerKeySources={[{ provider: 'openai', source: 'stored' }]} />);
  await user.click(screen.getByRole('button', { name: 'Add model' }));
  const menu = await screen.findByRole('dialog', { name: 'Add a model subagents may run on' });
  expect(within(menu).getByRole('option', { name: /GPT-6 Sol/u })).toBeInTheDocument();
  expect(within(menu).queryByRole('option', { name: /Claude Opus/u })).not.toBeInTheDocument();
});

it('keeps a chosen model that is no longer enabled, says so, and lets it be removed', () => {
  useAssistantSubagentPreferencesStore.getState().setModels(['openrouter::qwen/qwen-4-coder']);
  render(<SubagentModelsSection />);
  const list = screen.getByRole('list', { name: 'Models subagents may run on' });
  expect(within(list).getByText('Not enabled')).toBeInTheDocument();
  expect(
    within(list).getByRole('button', { name: 'Remove openrouter::qwen/qwen-4-coder' })
  ).toBeInTheDocument();
});
