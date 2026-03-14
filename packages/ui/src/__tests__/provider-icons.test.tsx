import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  getProviderIcon,
  ProviderIcon,
  renderProviderIcon,
} from '../model-picker/utils/provider-icons';

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
    expect(getProviderIcon('unknown-provider')).toBe(getProviderIcon('voyage'));
  });

  it('renders the deprecated helper through ProviderIcon', () => {
    const { container } = render(renderProviderIcon('openai', { className: 'deprecated-icon' }));

    expect(container.querySelector('svg.deprecated-icon')).not.toBeNull();
  });
});
