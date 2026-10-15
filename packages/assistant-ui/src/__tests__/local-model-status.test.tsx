// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LocalModelStatus } from '../local-model-status';

/**
 * The badge is presentational: the panel feeds it whatever stage the local
 * model load reports. Covered here directly so each stage keeps its contract
 * independently of which producer is wired up today.
 */
describe('LocalModelStatus', () => {
  it('shows a labelled progress bar and percent while downloading', () => {
    render(
      <LocalModelStatus
        state={{
          file: 'model.onnx',
          message: 'Downloading model weights...',
          progress: 33,
          stage: 'downloading',
        }}
      />
    );

    const status = screen.getByTestId('local-model-status');
    expect(within(status).getByText('33%')).toBeInTheDocument();
    expect(within(status).getByLabelText('Model downloading progress')).toBeInTheDocument();
  });

  it('keeps the percent visible while loading so the badge does not shift', () => {
    render(
      <LocalModelStatus
        state={{ message: 'Warming up local model host...', progress: 42, stage: 'loading' }}
      />
    );

    const status = screen.getByTestId('local-model-status');
    expect(within(status).getByText('42%')).toBeInTheDocument();
    expect(within(status).queryByLabelText('Model downloading progress')).not.toBeInTheDocument();
  });

  it('surfaces a failed load instead of hiding the badge', () => {
    render(
      <LocalModelStatus
        state={{
          message: 'Desktop llm host bridge is unavailable.',
          progress: 0,
          stage: 'error',
        }}
      />
    );

    expect(screen.getByTestId('local-model-status')).toBeInTheDocument();
  });
});
