/**
 * The composer's control row stays ONE line down to a 280px panel: chips give
 * up words, then chevrons, then shrink to icons, and the send button stays in
 * the card. Narrower, the icons wrap to a second line rather than run under
 * Send. Measured in a real browser because only layout shows the wrap.
 */
import {
  type AppendMessage,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { expect, onTestFinished, test } from 'vitest';
import { page } from 'vitest/browser';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import type { ModelPickerModel, ProviderGroupConfig } from '../assistant-ui-panel';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

const providerGroups: ProviderGroupConfig[] = [
  {
    label: 'Cloud',
    providers: [
      {
        capabilities: {
          streaming: true,
        },
        id: 'openai',
        models: [
          {
            default: true,
            enabled: true,
            id: 'gpt-5.4',
            label: 'GPT-5.4 with a long display name',
            supportsStreaming: true,
            type: 'llm',
          },
        ],
        name: 'OpenAI',
        runtime: 'hosted',
      },
    ],
    runtime: 'hosted',
  },
];
const pickerModels: ModelPickerModel[] = [
  {
    capabilities: { streaming: true, type: 'llm' },
    description: null,
    id: 'gpt-5.4',
    name: 'GPT-5.4 with a long display name',
    providerId: 'openai',
  },
];
const messages: readonly ThreadMessageLike[] = [];
const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => message;
const onNew = async (_message: AppendMessage): Promise<void> => undefined;

function Composer({ width }: { readonly width: number }) {
  const runtime = useExternalStoreRuntime({ convertMessage, messages, onNew });
  return (
    <TooltipProvider>
      <div style={{ height: 480, width }}>
        <AssistantConversationPanel
          accessMode={{ mode: 'full', onChange: () => undefined }}
          attachmentsAvailability={{ state: 'enabled' }}
          label="Assistant"
          onModelChange={() => undefined}
          onProviderSettingsChange={() => undefined}
          pickerModels={pickerModels}
          planMode={{ enabled: false, onToggle: () => undefined }}
          providerGroups={providerGroups}
          runtime={runtime}
          selectedModel="openai::gpt-5.4"
          selectedProvider="openai"
          threadKey="footer"
        />
      </div>
    </TooltipProvider>
  );
}

test.each([280, 360, 480, 720])(
  'keeps every composer control on one line at %ipx',
  async (width) => {
    const previous = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(Math.max(width, 320), 800);
    onTestFinished(() => page.viewport(previous.width, previous.height));
    render(<Composer width={width} />);

    const footer = await screen.findByTestId('assistant-composer-controls');
    const send = screen.getByTestId('assistant-composer-send');
    const card = footer.closest('.aui-composer-root');
    if (!card) {
      throw new Error('The composer footer renders inside its card');
    }
    const controls = Array.from(
      footer.querySelectorAll<HTMLElement>(
        '.bs-composer-chip, .bs-composer-icon-button, .aui-composer-send'
      )
    );
    expect(controls.length).toBeGreaterThanOrEqual(6);
    const middles = controls.map((control) => {
      const rect = control.getBoundingClientRect();
      return Math.round(rect.top + rect.height / 2);
    });
    // One row: every control is centred on the same line.
    expect(Math.max(...middles) - Math.min(...middles)).toBeLessThanOrEqual(2);
    // Nothing spills out of the card, and the send button keeps its size.
    const cardRect = card.getBoundingClientRect();
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(cardRect.left);
      expect(rect.right).toBeLessThanOrEqual(cardRect.right);
    }
    expect(send.getBoundingClientRect().width).toBeGreaterThanOrEqual(28);
    // Collapsed words stay in each control's accessible name.
    expect(screen.getByTestId('composer-access-mode-trigger')).toHaveAccessibleName(
      /access: full access/iu
    );
    expect(screen.getByRole('button', { name: 'Open assistant controls' })).toBeInTheDocument();
  }
);

test.each([200, 240, 280])('never runs a control under Send at %ipx', async (width) => {
  render(<Composer width={width} />);

  const footer = await screen.findByTestId('assistant-composer-controls');
  const send = screen.getByTestId('assistant-composer-send').getBoundingClientRect();
  const card = footer.closest('.aui-composer-root');
  if (!card) {
    throw new Error('The composer footer renders inside its card');
  }
  const cardRect = card.getBoundingClientRect();
  const controls = Array.from(
    footer.querySelectorAll<HTMLElement>('.bs-composer-chip, .bs-composer-icon-button')
  );
  expect(controls.length).toBeGreaterThanOrEqual(5);
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(cardRect.left);
    expect(rect.right).toBeLessThanOrEqual(cardRect.right);
    const overlapsSend =
      rect.left < send.right &&
      rect.right > send.left &&
      rect.top < send.bottom &&
      rect.bottom > send.top;
    expect(overlapsSend).toBe(false);
  }
  expect(send.width).toBeGreaterThanOrEqual(28);
});
