import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { modelMarkLabel } from '../model-picker/utils/model-mark-label';
import { ModelMark, ProviderIcon } from '../model-picker/utils/vendor-marks';

function markPath(container: HTMLElement): string | null | undefined {
  return container.querySelector('svg path')?.getAttribute('d');
}

describe('ProviderIcon', () => {
  it('draws each hosted provider and gateway with its own mark', () => {
    const paths = new Set<string | null | undefined>();
    for (const provider of ['openai', 'anthropic', 'google', 'openrouter', 'bedrock']) {
      const { container, unmount } = render(
        <ProviderIcon className="provider-icon" providerId={provider} />
      );
      expect(container.querySelector('svg.provider-icon')).not.toBeNull();
      paths.add(markPath(container));
      unmount();
    }
    expect(paths.size).toBe(5);
  });

  it('falls back to one generic icon for providers it has no mark for', () => {
    const unknown = render(<ProviderIcon providerId="unknown-provider" />).container.innerHTML;
    const other = render(<ProviderIcon providerId="another-unknown-provider" />).container
      .innerHTML;
    expect(unknown).toBe(other);
  });
});

describe('ModelMark', () => {
  it("shows the maker's mark alone when the maker serves its own model", () => {
    const { container } = render(
      <ModelMark label="Anthropic" provider="anthropic" vendor="anthropic" />
    );
    const mark = screen.getByRole('img', { name: 'Anthropic' });
    expect(mark.dataset['modelMark']).toBe('anthropic');
    expect(mark.dataset['modelRoute']).toBeUndefined();
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });

  it("badges a gateway's route beside the maker it serves", () => {
    const { container } = render(
      <ModelMark label="Anthropic via OpenRouter" provider="openrouter" vendor="anthropic" />
    );
    const mark = screen.getByRole('img', { name: 'Anthropic via OpenRouter' });
    expect(mark.dataset['modelMark']).toBe('anthropic');
    expect(mark.dataset['modelRoute']).toBe('openrouter');
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });

  it("shows the route's mark for a maker with no mark of its own", () => {
    const qwen = render(<ModelMark provider="openrouter" vendor="qwen" />).container;
    const route = render(<ProviderIcon providerId="openrouter" />).container;
    expect(markPath(qwen)).toBe(markPath(route));
    const nova = render(<ModelMark provider="bedrock" vendor="amazon" />).container;
    expect(nova.querySelector('[data-model-mark]')?.getAttribute('data-model-mark')).toBe(
      'bedrock'
    );
  });

  it('stays out of the accessibility tree without a label', () => {
    const { container } = render(<ModelMark provider="openai" vendor="openai" />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('modelMarkLabel', () => {
  it('names the maker, and the route only when it differs', () => {
    expect(
      modelMarkLabel({
        providerId: 'anthropic',
        providerName: 'Anthropic',
        vendorId: 'anthropic',
        vendorName: 'Anthropic',
      })
    ).toBe('Anthropic');
    expect(
      modelMarkLabel({
        providerId: 'bedrock',
        providerName: 'Amazon Bedrock',
        vendorId: 'anthropic',
        vendorName: 'Anthropic',
      })
    ).toBe('Anthropic via Amazon Bedrock');
    expect(modelMarkLabel({ providerId: 'openrouter', providerName: 'OpenRouter' })).toBe(
      'OpenRouter'
    );
  });
});
