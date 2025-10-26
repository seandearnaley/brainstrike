import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Utility to dynamically import the main entry after setting up mocks
const importMain = () => import('../main');

describe('main entry file', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  test('throws an error when root element is missing', async () => {
    vi.spyOn(document, 'getElementById').mockReturnValue(null);
    await expect(importMain()).rejects.toThrow("Failed to find the root element with ID 'root'");
  }, 60000);

  test('creates React root and renders routing components', async () => {
    const rootElement = document.createElement('div');
    rootElement.id = 'root';
    vi.spyOn(document, 'getElementById').mockReturnValue(rootElement);

    const renderMock = vi.fn();
    const createRootMock = vi.fn(() => ({ render: renderMock }));

    vi.doMock('react-dom/client', () => ({
      __esModule: true,
      default: { createRoot: createRootMock },
    }));

    // Mock providers to render children directly
    vi.mock('react-helmet-async', () => ({
      HelmetProvider: ({ children }: { children: React.ReactNode }) => children,
    }));
    vi.mock('@brainstrike/db', () => ({
      DbProvider: ({ children }: { children: React.ReactNode }) => children,
    }));
    vi.mock('@brainstrike/file-explorer-hooks', () => ({
      AdaptersProvider: ({ children }: { children: React.ReactNode }) => children,
    }));
    vi.mock('@brainstrike/file-system', () => ({
      createFileSystemAdapter: () => ({}),
    }));
    vi.mock('@brainstrike/storage', () => ({
      createStorageAdapter: () => ({}),
    }));

    vi.mock('../app/root-layout-content', () => ({
      __esModule: true,
      default: () => <div data-testid="root-layout">Root Layout</div>,
    }));
    vi.mock('../app/home-page-content', () => ({
      __esModule: true,
      default: () => <div data-testid="home-page">Home Page</div>,
    }));
    vi.mock('../app/settings/page-content', () => ({
      __esModule: true,
      default: () => <div data-testid="settings-page">Settings Page</div>,
    }));

    await importMain();

    expect(createRootMock).toHaveBeenCalledWith(rootElement);
    expect(renderMock).toHaveBeenCalled();

    const element = renderMock.mock.calls[0]?.[0] as ReactElement;
    render(element);

    // Verify mocked routing components render without crashing
    expect(screen.getByTestId('root-layout')).toBeInTheDocument();
  }, 60000);
});
