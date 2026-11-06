import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ModelSelect, type ModelSelectOption } from '../model-picker/model-select';

// cmdk scrolls the active option into view; happy-dom has no layout.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const OPTIONS: readonly ModelSelectOption[] = [
  { label: 'Auto (chat’s provider)', value: 'auto' },
  {
    label: 'GPT-5.4 Mini',
    markLabel: 'OpenAI',
    provider: 'openai',
    value: 'openai/gpt-5.4-mini',
    vendor: 'openai',
  },
  {
    label: 'Claude Haiku 5.5 (OpenRouter)',
    markLabel: 'Anthropic via OpenRouter',
    provider: 'openrouter',
    value: 'openrouter/anthropic/claude-haiku-5.5',
    vendor: 'anthropic',
  },
];

function Field() {
  const [value, setValue] = useState('auto');
  return (
    <>
      <label htmlFor="observer">Observer</label>
      <ModelSelect id="observer" onValueChange={setValue} options={OPTIONS} value={value} />
    </>
  );
}

describe('ModelSelect', () => {
  it('is a combobox named by its label that shows the chosen option', () => {
    render(<Field />);
    expect(screen.getByRole('combobox', { name: 'Observer' }).textContent).toBe(
      'Auto (chat’s provider)'
    );
  });

  it('searches by name or maker, and a pick closes the menu and shows its mark', async () => {
    const user = userEvent.setup();
    render(<Field />);
    await user.click(screen.getByRole('combobox', { name: 'Observer' }));
    const menu = await screen.findByRole('dialog', { name: 'Choose a model' });
    await user.type(within(menu).getByRole('combobox'), 'anthropic');
    expect(
      within(menu)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Claude Haiku 5.5 (OpenRouter)']);
    await user.click(within(menu).getByRole('option', { name: /Claude Haiku/u }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const field = screen.getByRole('combobox', { name: 'Observer' });
    expect(field.textContent).toBe('Claude Haiku 5.5 (OpenRouter)');
    const mark = field.querySelector('[data-model-mark]');
    expect(mark?.getAttribute('data-model-mark')).toBe('anthropic');
    expect(mark?.getAttribute('data-model-route')).toBe('openrouter');
  });
});
