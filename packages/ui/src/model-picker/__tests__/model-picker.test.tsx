import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../model-picker';
import type { ModelPickerModel, ModelPickerProvider } from '../types';

// Mock ResizeObserver for Radix
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock scrollIntoView
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// Mock pointer capture methods
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();

vi.mock('../../theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

const providers: ModelPickerProvider[] = [{ id: 'openai', name: 'OpenAI' }];

const models: ModelPickerModel[] = [
  { id: 'gpt-4', name: 'GPT-4', providerId: 'openai', capabilities: { type: 'llm' } },
];

describe('ModelPicker', () => {
  it('renders trigger with placeholder', () => {
    render(<ModelPicker models={models} providers={providers} />);
    expect(screen.getByText('Select a model...')).toBeInTheDocument();
  });

  it('opens on click and shows options', () => {
    render(<ModelPicker models={models} providers={providers} />);
    fireEvent.click(screen.getByText('Select a model...'));
    expect(screen.getByText('GPT-4')).toBeInTheDocument();
  });

  it('selects an option', () => {
    const onChange = vi.fn();
    render(<ModelPicker models={models} providers={providers} onChange={onChange} />);
    fireEvent.click(screen.getByText('Select a model...'));
    fireEvent.click(screen.getByText('GPT-4'));
    expect(onChange).toHaveBeenCalledWith('gpt-4');
  });
});
