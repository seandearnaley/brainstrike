import { useAssistantLinkCapabilities } from '@brainstrike/assistant-ui/assistant-link-capabilities';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '../platform-bridge';

/**
 * The unit tests in `@brainstrike/assistant-ui` prove the link COMPONENT
 * behaves; they wire the provider by hand. This proves the other half: that the
 * real `AssistantChatPanel` actually supplies that context to the panel
 * subtree. Without it the component is correct and the app still shows dead
 * links — it would just log instead of navigating.
 */

vi.mock('../hooks/use-assistant-availability-with-local', () => ({
  useAssistantAvailabilityWithLocal: () => ({
    model: 'claude-opus-5',
    provider: 'anthropic',
    providers: ['anthropic'],
    state: 'enabled',
  }),
}));

// Stand in for the lazily-loaded panel: a probe that consumes the seam exactly
// where the real markdown renderer consumes it.
vi.mock('../assistant-ui-panel-wrapper-lazy', () => ({
  AssistantUiPanelWrapperLazy: (): ReactElement => {
    const capabilities = useAssistantLinkCapabilities();
    return (
      <button
        onClick={() => {
          void capabilities?.openLink('https://example.com/docs');
        }}
        type="button"
      >
        {capabilities ? 'seam-present' : 'seam-missing'}
      </button>
    );
  },
}));

const setPlatform = (bridge: Partial<PlatformBridge> | undefined) => {
  (window as unknown as { platform?: Partial<PlatformBridge> | undefined }).platform = bridge;
};

const { AssistantChatPanel, AssistantProviderStatusProvider } = await import(
  '../assistant-chat-panel'
);

describe('AssistantChatPanel link seam wiring', () => {
  afterEach(() => {
    setPlatform(undefined);
    vi.restoreAllMocks();
  });

  it('provides the link seam to the panel subtree', () => {
    render(<AssistantChatPanel />, { wrapper: AssistantProviderStatusProvider });

    expect(screen.getByRole('button', { name: 'seam-present' })).toBeInTheDocument();
  });

  it('reaches the validated desktop shell bridge end to end', async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true });
    setPlatform({
      openExternal,
      openPath: vi.fn(),
      showItemInFolder: vi.fn(),
    });

    render(<AssistantChatPanel />, { wrapper: AssistantProviderStatusProvider });
    await userEvent.click(screen.getByRole('button', { name: 'seam-present' }));

    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });
});
