import './model-picker-short-window.browser.css';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ModelSelect } from '../model-picker/model-select';
import { ThemeProvider } from '../theme-provider';

afterEach(cleanup);

const options = Array.from({ length: 12 }, (_, index) => ({
  label: `Model ${index}`,
  provider: 'openrouter',
  value: `openrouter::model-${index}`,
  vendor: 'qwen',
}));

function Field() {
  const [chosen, setChosen] = useState('');
  return (
    // The trigger sits mid-window, so neither side has room for the whole list.
    <div style={{ paddingLeft: 16, paddingTop: 280, width: 360 }}>
      <label htmlFor="chat-model">Chat model</label>
      <ModelSelect id="chat-model" onValueChange={setChosen} options={options} value={chosen} />
      <output data-testid="chosen">{chosen}</output>
    </div>
  );
}

test('the last model stays inside a short window and can be picked', async () => {
  // The app's minimum window height.
  await page.viewport(1024, 600);
  render(
    <ThemeProvider defaultMode="light">
      <Field />
    </ThemeProvider>
  );
  await userEvent.click(await screen.findByRole('combobox', { name: 'Chat model' }));
  const last = await screen.findByRole('option', { name: /Model 11/u });
  const list = last.closest<HTMLElement>('[cmdk-list]');
  if (!list) {
    throw new Error('The model option is not inside the model list');
  }
  list.scrollTop = list.scrollHeight;

  // The whole menu, its search included, fits the window; its list scrolls.
  const menu = screen.getByRole('dialog', { name: 'Choose a model' });
  await waitFor(() => {
    for (const element of [menu, last]) {
      const { bottom, top } = element.getBoundingClientRect();
      expect(top).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeLessThanOrEqual(window.innerHeight);
    }
  });
  await userEvent.click(last);
  expect(screen.getByTestId('chosen').textContent).toBe('openrouter::model-11');
});
