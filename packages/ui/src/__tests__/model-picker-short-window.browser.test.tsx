import './model-picker-short-window.browser.css';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ModelPicker } from '../model-picker/model-picker';
import type { ModelPickerModel } from '../model-picker/types';
import { ThemeProvider, type ThemeStorageAdapter } from '../theme-provider';

afterEach(cleanup);

const models: ModelPickerModel[] = Array.from({ length: 12 }, (_, index) => ({
  capabilities: { defaultDimension: 384, type: 'embedding' },
  id: `model-${index}`,
  name: `Model ${index}`,
  providerId: 'local',
}));

const themeStorage: ThemeStorageAdapter = {
  getItem: () => Promise.resolve('light'),
  setItem: () => Promise.resolve(),
};

function Picker() {
  const [chosen, setChosen] = useState('none');
  return (
    // The trigger sits mid-window, so neither side has room for the whole list.
    <div style={{ paddingLeft: 16, paddingTop: 280 }}>
      <ModelPicker
        models={models}
        onChange={(next) => setChosen(String(next))}
        placeholder="Embedding model"
        providers={[{ id: 'local', name: 'Local' }]}
      />
      <output data-testid="chosen">{chosen}</output>
    </div>
  );
}

test('the last model stays inside a short window and can be picked', async () => {
  // The app's minimum window height.
  await page.viewport(1024, 600);
  render(
    <ThemeProvider storageAdapter={themeStorage}>
      <Picker />
    </ThemeProvider>
  );
  await userEvent.click(await screen.findByRole('combobox'));
  const last = await screen.findByRole('option', { name: /Model 11/ });
  const list = last.closest<HTMLElement>('[cmdk-list]');
  if (!list) {
    throw new Error('The model option is not inside the model list');
  }
  list.scrollTop = list.scrollHeight;

  await waitFor(() => {
    const { bottom, top } = last.getBoundingClientRect();
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(window.innerHeight);
  });
  await userEvent.click(last);
  expect(screen.getByTestId('chosen').textContent).toBe('model-11');
});
