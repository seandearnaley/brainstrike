import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FactoryResetSettingsSection } from '../settings/system/factory-reset-settings-section';

// Mock the FactoryResetPanel component
vi.mock('../settings/system/factory-reset-panel', () => ({
  FactoryResetPanel: () => <div data-testid="factory-reset-panel">Factory Reset Panel</div>,
}));

// Mock the ClearStoredFoldersPanel component
vi.mock('../settings/system/clear-stored-folders-panel', () => ({
  ClearStoredFoldersPanel: ({
    isWebPlatform,
    hasStoredFolders,
  }: {
    isWebPlatform?: boolean;
    hasStoredFolders?: boolean;
  }) => {
    // Mirror the real component's behavior - return null when not web platform
    if (!isWebPlatform) {
      return null;
    }
    return (
      <div
        data-has-stored-folders={hasStoredFolders}
        data-is-web-platform={isWebPlatform}
        data-testid="clear-stored-folders-panel"
      >
        Clear Stored Folders Panel
      </div>
    );
  },
}));

// Mock the InlineFixtureSettingsPanel component
vi.mock('../settings/system/inline-fixture-settings-panel', () => ({
  InlineFixtureSettingsPanel: ({
    isAvailable,
    isLoading,
    checked,
  }: {
    isAvailable?: boolean;
    isLoading?: boolean;
    checked?: boolean;
  }) => {
    // Mirror the real component's behavior - return null when not available
    if (!isAvailable) {
      return null;
    }
    return (
      <div
        data-checked={checked}
        data-is-available={isAvailable}
        data-is-loading={isLoading}
        data-testid="inline-fixture-settings-panel"
      >
        Inline Fixture Settings Panel
      </div>
    );
  },
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

  describe('ClearStoredFoldersPanel integration', () => {
    it('renders ClearStoredFoldersPanel on web platform by default', () => {
      render(<FactoryResetSettingsSection />);

      expect(screen.getByTestId('clear-stored-folders-panel')).toBeInTheDocument();
    });

    it('renders ClearStoredFoldersPanel when isWebPlatform is true', () => {
      render(<FactoryResetSettingsSection isWebPlatform={true} />);

      expect(screen.getByTestId('clear-stored-folders-panel')).toBeInTheDocument();
    });

    it('does not render ClearStoredFoldersPanel on desktop platform', () => {
      render(<FactoryResetSettingsSection isWebPlatform={false} />);

      expect(screen.queryByTestId('clear-stored-folders-panel')).not.toBeInTheDocument();
    });

    it('passes hasStoredFolders prop to ClearStoredFoldersPanel', () => {
      render(<FactoryResetSettingsSection hasStoredFolders={true} />);

      const panel = screen.getByTestId('clear-stored-folders-panel');
      expect(panel).toHaveAttribute('data-has-stored-folders', 'true');
    });

    it('defaults hasStoredFolders to false', () => {
      render(<FactoryResetSettingsSection />);

      const panel = screen.getByTestId('clear-stored-folders-panel');
      expect(panel).toHaveAttribute('data-has-stored-folders', 'false');
    });
  });

  describe('InlineFixtureSettingsPanel integration', () => {
    it('renders InlineFixtureSettingsPanel when available', () => {
      render(
        <FactoryResetSettingsSection
          inlineFixtureSetting={{
            available: true,
            checked: false,
            loading: false,
            onChange: vi.fn(),
          }}
        />
      );

      expect(screen.getByTestId('inline-fixture-settings-panel')).toBeInTheDocument();
    });

    it('does not render InlineFixtureSettingsPanel when not available', () => {
      render(
        <FactoryResetSettingsSection
          inlineFixtureSetting={{
            available: false,
            checked: false,
            loading: false,
            onChange: vi.fn(),
          }}
        />
      );

      expect(screen.queryByTestId('inline-fixture-settings-panel')).not.toBeInTheDocument();
    });

    it('does not render InlineFixtureSettingsPanel when not provided', () => {
      render(<FactoryResetSettingsSection />);

      expect(screen.queryByTestId('inline-fixture-settings-panel')).not.toBeInTheDocument();
    });

    it('passes checked prop to InlineFixtureSettingsPanel', () => {
      render(
        <FactoryResetSettingsSection
          inlineFixtureSetting={{
            available: true,
            checked: true,
            loading: false,
            onChange: vi.fn(),
          }}
        />
      );

      const panel = screen.getByTestId('inline-fixture-settings-panel');
      expect(panel).toHaveAttribute('data-checked', 'true');
    });

    it('passes loading prop to InlineFixtureSettingsPanel', () => {
      render(
        <FactoryResetSettingsSection
          inlineFixtureSetting={{
            available: true,
            checked: false,
            loading: true,
            onChange: vi.fn(),
          }}
        />
      );

      const panel = screen.getByTestId('inline-fixture-settings-panel');
      expect(panel).toHaveAttribute('data-is-loading', 'true');
    });
  });

  describe('backward compatibility', () => {
    it('works with no props (default behavior)', () => {
      render(<FactoryResetSettingsSection />);

      // Should render heading and description
      expect(screen.getByRole('heading', { name: 'Factory Reset' })).toBeInTheDocument();
      // Should render FactoryResetPanel
      expect(screen.getByTestId('factory-reset-panel')).toBeInTheDocument();
      // Should render ClearStoredFoldersPanel (web platform is default)
      expect(screen.getByTestId('clear-stored-folders-panel')).toBeInTheDocument();
      // Should NOT render InlineFixtureSettingsPanel (not provided)
      expect(screen.queryByTestId('inline-fixture-settings-panel')).not.toBeInTheDocument();
    });
  });
});
