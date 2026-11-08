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

const configured = ['openai', 'openrouter'] as const;

beforeEach(() => {
  useAssistantSubagentPreferencesStore.getState().setModels([]);
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
  render(<SubagentModelsSection configuredProviders={configured} />);
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
  render(<SubagentModelsSection configuredProviders={['openai']} />);
  await user.click(screen.getByRole('button', { name: 'Add model' }));
  const menu = await screen.findByRole('dialog', { name: 'Add a model subagents may run on' });
  expect(within(menu).getByRole('option', { name: /GPT-6 Sol/u })).toBeInTheDocument();
  expect(within(menu).queryByRole('option', { name: /Claude Opus/u })).not.toBeInTheDocument();
});

it('cannot add a model once every enabled model with a key is allowed', () => {
  useAssistantSubagentPreferencesStore
    .getState()
    .setModels(['openai::gpt-6-sol', 'openrouter::anthropic/claude-opus-5.5']);
  render(<SubagentModelsSection configuredProviders={configured} />);
  expect(screen.getByRole('button', { name: 'Add model' })).toBeDisabled();
});

it('says why an allowed model cannot run: disabled, without a key, or gone from the catalog', () => {
  useAssistantSubagentPreferencesStore
    .getState()
    .setModels(['openrouter::qwen/qwen-4-coder', 'openai::gpt-6-sol', 'openrouter::gone/model']);
  render(<SubagentModelsSection configuredProviders={['openrouter']} />);
  const list = screen.getByRole('list', { name: 'Models subagents may run on' });
  const rows = within(list).getAllByRole('listitem');
  // A disabled model keeps its name.
  expect(rows[0]).toHaveTextContent('Qwen 4 Coder (OpenRouter)Not enabled');
  expect(rows[1]).toHaveTextContent('GPT-6 SolProvider not connected');
  expect(rows[2]).toHaveTextContent('openrouter::gone/modelNot in the catalog');
  expect(
    within(list).getByRole('button', { name: 'Remove openrouter::gone/model' })
  ).toBeInTheDocument();
});

it('offers nothing and says nothing before the catalog and the keys are known', () => {
  useAssistantSubagentPreferencesStore.getState().setModels(['openai::gpt-6-sol']);
  useModelRegistryStore.setState({ hasLoaded: false, models: [] });
  const { rerender } = render(<SubagentModelsSection configuredProviders={configured} />);
  expect(screen.getByRole('button', { name: 'Add model' })).toBeDisabled();
  expect(
    screen.queryByText(/Not in the catalog|Not enabled|Provider not connected/u)
  ).not.toBeInTheDocument();

  // The catalog loaded but the keys' status is still unknown.
  useModelRegistryStore.setState({
    hasLoaded: true,
    models: [model('openai', 'gpt-6-sol', 'GPT-6 Sol')],
  });
  rerender(<SubagentModelsSection />);
  expect(screen.getByRole('button', { name: 'Add model' })).toBeDisabled();
});

it('shows providers that failed to load, and offers nothing', () => {
  render(<SubagentModelsSection providersError="The keychain is locked." />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    'The connected providers didn’t load: The keychain is locked.'
  );
  expect(screen.getByRole('button', { name: 'Add model' })).toBeDisabled();
});

it('shows a catalog that failed to load, and offers nothing from it', () => {
  useModelRegistryStore.setState({
    error: 'The catalog store is locked.',
    hasLoaded: true,
    models: [],
  });
  render(<SubagentModelsSection configuredProviders={configured} />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    'The model catalog didn’t load: The catalog store is locked.'
  );
  expect(screen.getByRole('button', { name: 'Add model' })).toBeDisabled();
});
