// @vitest-environment jsdom
/**
 * What a blocked composer still lets the user do, driven through the shipped
 * conversation over a published committed view:
 * - over the budget cap, the draft stays editable and only sending is held
 *   (the Send button and every Enter path), with a way to raise the cap;
 * - a new thread that cannot send yet says why on its welcome and offers the
 *   one step that fixes it, where the host can take the user there.
 */
import '@testing-library/jest-dom/vitest';
import type { AppendMessage } from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BudgetGuardrailContextValue,
  BudgetGuardrailProvider,
} from '../budget-guardrail-context';
import {
  CommittedAssistantConversation,
  type CommittedAssistantConversationProps,
} from '../committed-assistant-conversation';
import { PublishedConversation } from './committed-assistant-test-support';

const overCap = (
  overrides: Partial<BudgetGuardrailContextValue> = {}
): BudgetGuardrailContextValue => ({
  adjustCap: vi.fn(),
  overridden: false,
  override: vi.fn(),
  status: { capUsd: 10, estimatedUsd: 1, overCap: true, spentUsd: 10, unpricedModelCount: 0 },
  ...overrides,
});

function renderConversation({
  budget = null,
  onNew = vi.fn(async (_message: AppendMessage) => undefined),
  ...presentation
}: Partial<Omit<CommittedAssistantConversationProps, 'commands' | 'store'>> & {
  readonly budget?: BudgetGuardrailContextValue | null;
  readonly onNew?: (message: AppendMessage) => Promise<void>;
}) {
  const store = new PublishedConversation('send-gates', []);
  render(
    <TooltipProvider>
      <BudgetGuardrailProvider value={budget}>
        <CommittedAssistantConversation
          commands={{ onCancel: async () => undefined, onNew }}
          label="Send gates"
          store={store}
          {...presentation}
        />
      </BudgetGuardrailProvider>
    </TooltipProvider>
  );
  return { onNew };
}

const input = () => screen.getByRole('textbox', { name: 'Message input' });

describe('over the budget cap', () => {
  afterEach(cleanup);

  it('keeps the draft editable while Send and Enter stay held', async () => {
    const user = userEvent.setup();
    const { onNew } = renderConversation({ budget: overCap() });

    expect(input()).toBeEnabled();
    await user.type(input(), 'finish this thought');
    await user.keyboard('{Enter}');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(input()).toHaveValue('finish this thought');
    expect(screen.getByTestId('assistant-composer-send')).toBeDisabled();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('still breaks the line on Shift+Enter', async () => {
    const user = userEvent.setup();
    renderConversation({ budget: overCap() });

    await user.type(input(), 'one{Shift>}{Enter}{/Shift}two');

    expect(input()).toHaveValue('one\ntwo');
  });

  it('sends on Enter once the cap is overridden', async () => {
    const user = userEvent.setup();
    const { onNew } = renderConversation({ budget: overCap({ overridden: true }) });

    await user.type(input(), 'go{Enter}');

    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('offers to adjust the cap where the host can open the setting', async () => {
    const user = userEvent.setup();
    const budget = overCap();
    renderConversation({ budget });

    await user.click(screen.getByRole('button', { name: 'Adjust cap' }));

    expect(budget.adjustCap).toHaveBeenCalledTimes(1);
  });

  it('offers no cap link without one', () => {
    renderConversation({ budget: overCap({ adjustCap: undefined }) });

    expect(screen.getByRole('button', { name: 'Send anyway' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Adjust cap' })).toBeNull();
  });
});

describe('a new thread that cannot send yet', () => {
  afterEach(cleanup);

  const reason = 'Connect an AI provider in Settings → Providers to enable the assistant.';

  it('shows the reason with the action that fixes it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderConversation({
      disabledAction: { label: 'Connect a provider', onSelect },
      disabledReason: reason,
      isComposerDisabled: true,
      welcome: true,
    });

    const welcome = screen.getByTestId('new-thread-welcome');
    expect(welcome).toHaveTextContent(reason);
    await user.click(screen.getByRole('button', { name: 'Connect a provider' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows the reason as text alone where the host offers no action', () => {
    renderConversation({ disabledReason: reason, isComposerDisabled: true, welcome: true });

    expect(screen.getByTestId('new-thread-disabled-reason')).toHaveTextContent(reason);
    expect(screen.queryByRole('button', { name: 'Connect a provider' })).toBeNull();
  });
});
