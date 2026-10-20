import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProviderIcon } from '../model-picker/utils/provider-icons';

describe('provider icons', () => {
  it('renders supported provider icons', () => {
    for (const provider of ['openai', 'anthropic', 'google', 'openrouter', 'cohere', 'voyage']) {
      const { container, unmount } = render(
        <ProviderIcon className="provider-icon" providerId={provider} />
      );

      expect(container.querySelector('svg.provider-icon')).not.toBeNull();
      unmount();
    }
  });

  it('falls back to the Bot icon for unknown providers', () => {
    const unknown = render(<ProviderIcon providerId="unknown-provider" />).container.innerHTML;
    const bot = render(<ProviderIcon providerId="voyage" />).container.innerHTML;

    expect(unknown).toBe(bot);
  });
});
