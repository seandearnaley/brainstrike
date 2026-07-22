import './assistant-ui-panel-wrapper-test-support';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { renderAssistantPanel } from './assistant-ui-panel-wrapper-test-support';

describe('assistant provider-settings validation', () => {
  test('disables send until the invalid draft is cleared or the provider changes', async () => {
    const user = userEvent.setup();
    await renderAssistantPanel(['openai', 'anthropic']);

    await waitFor(() => expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false'));
    await user.click(screen.getByTestId('provider-settings-invalid'));
    await waitFor(() => {
      expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
      expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
        'Output limit exceeds the 65,535 maximum from OpenRouter live.'
      );
    });

    await user.selectOptions(screen.getByTestId('provider-select'), 'anthropic');
    await waitFor(() => expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false'));

    await user.click(screen.getByTestId('provider-settings-invalid'));
    await user.click(screen.getByTestId('provider-settings-valid'));
    await waitFor(() => expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false'));
  });
});
