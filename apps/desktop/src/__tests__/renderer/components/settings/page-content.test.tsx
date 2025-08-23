import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Ensure file-saver is mocked for this suite
vi.mock('file-saver', () => ({
  saveAs: vi.fn(),
  default: { saveAs: vi.fn() },
}));

// Mock the app-shell components before importing
vi.mock('@brainstrike/app-shell', () => ({
  SettingsPageContent: ({ children }: { children?: React.ReactNode }) => (
    <div>
      <h1>Settings</h1>
      <h2>Appearance</h2>
      <div>theme-settings-mock</div>
      {children}
    </div>
  ),
}));

import SettingsPageContent from '../../../../renderer/components/settings/page-content';

describe('SettingsPageContent', () => {
  it('renders without crashing', () => {
    const { container } = render(<SettingsPageContent />);

    // Just check that the component renders without throwing
    expect(container).toBeInTheDocument();
  });
});
