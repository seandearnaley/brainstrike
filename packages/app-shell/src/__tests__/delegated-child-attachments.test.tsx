// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  type DbModel,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DelegatedChildConversationPanel } from '../delegated-child-conversation-panel';
import { createDelegatedConversationStore } from '../delegated-conversation-store';

vi.mock('@brainstrike/assistant-data', async (original) => ({
  ...(await original<typeof import('@brainstrike/assistant-data')>()),
  hasDurableAssistantUsageCapability: () => true,
}));
vi.mock('../use-file-mentions', () => ({ useFileMentions: () => ({ fileMentions: undefined }) }));
vi.mock('../use-assistant-slash-commands', () => ({ useAssistantSlashCommands: () => undefined }));
const providerDiscovery = vi.hoisted(() => ({ error: undefined as string | undefined }));
vi.mock('../hooks/use-configured-assistant-providers', () => ({
  useConfiguredAssistantProviders: () => ({
    discoveryError: providerDiscovery.error,
    discoveryState: providerDiscovery.error ? 'error' : 'ready',
    providers: ['openai'],
  }),
}));
const originalRegistry = useModelRegistryStore.getState();
afterEach(() => {
  cleanup();
  providerDiscovery.error = undefined;
  useModelRegistryStore.setState(originalRegistry, true);
});
const model = (id: string, vision: boolean): DbModel => ({
  bestFor: null,
  capabilities: { type: 'llm', vision },
  description: null,
  icon: null,
  id,
  isEnabled: true,
  name: id,
  parameters: null,
  providerId: 'openai',
  sortOrder: 0,
  tagline: null,
});
it.each([
  { enabled: false, inherited: 'openai::text', pin: undefined, previous: 'vision', running: false },
  { enabled: true, inherited: 'openai::text', pin: 'vision', previous: 'text', running: false },
  { enabled: false, inherited: 'openai::vision', pin: undefined, previous: 'text', running: true },
])(
  'uses the actual active or next child model for image admission %#',
  ({ running, pin, inherited, previous, enabled }) => {
    useModelRegistryStore.setState({ models: [model('vision', true), model('text', false)] });
    const persona = BUILT_IN_PERSONAS[0];
    if (!persona) {
      throw new Error('Missing canonical persona');
    }
    render(
      <TooltipProvider>
        <DelegatedChildConversationPanel
          allowIdleInput
          inheritedModel={inherited}
          insights={{
            status: 'ready',
            value: {
              configuration: {
                maxSteps: 8,
                persona: {
                  ...persona,
                  model: pin ? { modelId: pin, provider: 'openai' } : undefined,
                },
              },
              depth: 1,
              directUsage: null,
              latestExecutionConfiguration: null,
              latestRun: {
                model: previous,
                modelSettings: null,
                provider: 'openai',
                providerOptions: null,
              },
              subtreeUsage: null,
              threadId: 'child',
            },
          }}
          isRunning={running}
          label="Child"
          onNew={async () => {}}
          onSendActiveInput={async () => {}}
          persistedHistory={{ messages: [] }}
          store={createDelegatedConversationStore('root')}
          threadId="child"
        />
      </TooltipProvider>
    );
    const attach = screen.getByTestId('assistant-attach-image');
    if (enabled) {
      expect(attach).toBeEnabled();
    } else {
      expect(attach).toBeDisabled();
    }
  }
);

it('surfaces provider discovery failure beside the child composer', () => {
  providerDiscovery.error = 'Provider discovery failed: OS keychain is locked';
  useModelRegistryStore.setState({ models: [model('text', false)] });
  const persona = BUILT_IN_PERSONAS[0];
  if (!persona) {
    throw new Error('Missing canonical persona');
  }
  render(
    <TooltipProvider>
      <DelegatedChildConversationPanel
        allowIdleInput
        inheritedModel="openai::text"
        insights={{
          status: 'ready',
          value: {
            configuration: { maxSteps: 8, persona },
            depth: 1,
            directUsage: null,
            latestExecutionConfiguration: null,
            latestRun: null,
            subtreeUsage: null,
            threadId: 'child',
          },
        }}
        label="Child"
        onNew={async () => {}}
        onSendActiveInput={async () => {}}
        panelProps={{ className: 'min-h-20 flex-none' }}
        persistedHistory={{ messages: [] }}
        store={createDelegatedConversationStore('root')}
        threadId="child"
      />
    </TooltipProvider>
  );
  const alert = screen.getByRole('alert');
  const panel = screen.getByTestId('assistant-conversation-panel');
  expect(alert).toHaveTextContent('OS keychain is locked');
  expect(alert).toHaveClass('shrink-0');
  expect(alert.parentElement).toHaveClass('flex', 'h-full', 'min-h-0', 'flex-col');
  expect(panel).toHaveClass('min-h-0', 'flex-1');
});

it('keeps an idle child composer disabled until its admitted configuration loads', () => {
  render(
    <TooltipProvider>
      <DelegatedChildConversationPanel
        allowIdleInput
        inheritedModel="openai::text"
        insights={{ status: 'loading' }}
        label="Child"
        onNew={async () => {}}
        onSendActiveInput={async () => {}}
        persistedHistory={{ messages: [] }}
        store={createDelegatedConversationStore('root')}
        threadId="child"
      />
    </TooltipProvider>
  );

  expect(screen.getByRole('textbox', { name: 'Message input' })).toBeDisabled();
});
