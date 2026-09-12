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
const originalRegistry = useModelRegistryStore.getState();
afterEach(() => {
  cleanup();
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
