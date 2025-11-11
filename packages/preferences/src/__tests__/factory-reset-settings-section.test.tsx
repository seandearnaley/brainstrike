import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FactoryResetSettingsSection } from '../factory-reset/factory-reset-settings-section';

// Mock the FactoryResetPanel component
vi.mock('../factory-reset/factory-reset-panel', () => ({
  FactoryResetPanel: () => <div data-testid="factory-reset-panel">Factory Reset Panel</div>,
}));

describe('FactoryResetSettingsSection', () => {
  describe('rendering', () => {
    it('renders section heading and description', () => {
      render(<FactoryResetSettingsSection />);

      expect(screen.getByRole('heading', { name: 'Factory Reset' })).toBeInTheDocument();
      expect(
        screen.getByText('Wipe application data (files, embeddings, queues) and reset preferences.')
      ).toBeInTheDocument();
    });

    it('renders FactoryResetPanel component', () => {
      render(<FactoryResetSettingsSection />);

      expect(screen.getByTestId('factory-reset-panel')).toBeInTheDocument();
    });

    it('applies correct spacing classes', () => {
      const { container } = render(<FactoryResetSettingsSection />);

      // Main container should have space-y-4
      const mainContainer = container.firstChild as HTMLElement;
      expect(mainContainer.className).toContain('space-y-4');
    });
  });

  describe('structure', () => {
    it('renders heading as h3 with correct styling', () => {
      render(<FactoryResetSettingsSection />);

      const heading = screen.getByRole('heading', { name: 'Factory Reset' });
      expect(heading.tagName).toBe('H3');
      expect(heading.className).toContain('text-lg');
      expect(heading.className).toContain('font-semibold');
    });

    it('renders description with correct styling', () => {
      render(<FactoryResetSettingsSection />);

      const description = screen.getByText(
        'Wipe application data (files, embeddings, queues) and reset preferences.'
      );
      expect(description.tagName).toBe('P');
      expect(description.className).toContain('text-sm');
      expect(description.className).toContain('text-muted-foreground');
    });
  });
});
