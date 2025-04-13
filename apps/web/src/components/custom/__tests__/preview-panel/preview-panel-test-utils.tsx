import { screen, render as testingLibraryRender } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { userEvent as createUserEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { ReactElement } from 'react';
import { afterEach, vi } from 'vitest';
import { ThemeProvider } from '../../../../providers/theme-provider';

// Create a userEvent instance with empty options
const userEvent = {
  ...createUserEvent,
  setup: (options = {}) => createUserEvent.setup(options),
};

// Common mocks
vi.mock('../../../../components/ui/use-toast', () => ({
  useToast: () => ({
    toast: vi.fn().mockReturnValue({
      id: 'mock-toast-id',
      dismiss: vi.fn(),
    }),
  }),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  ChevronDown: () => <div data-testid="mock-chevron-down">ChevronDown</div>,
  ChevronUp: () => <div data-testid="mock-chevron-up">ChevronUp</div>,
  Copy: () => <div data-testid="mock-copy">Copy</div>,
  Download: () => <div data-testid="mock-download">Download</div>,
  FileText: () => <div data-testid="mock-file-text">FileText</div>,
  Folder: () => <div data-testid="mock-folder">Folder</div>,
  FolderOpen: () => <div data-testid="mock-folder-open">FolderOpen</div>,
  X: () => <div data-testid="mock-x">X</div>,
}));

// Mock ResizeObserver
const mockResizeObserver = vi.fn(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

window.ResizeObserver = mockResizeObserver;

afterEach(() => {
  vi.restoreAllMocks();
});

// Mock Accordion component
vi.mock('@/components/ui/accordion', () => {
  const AccordionRoot = ({ children }: { children: ReactNode }) => (
    <div data-testid="mock-accordion">{children}</div>
  );
  const AccordionItem = ({ children }: { children: ReactNode }) => (
    <div data-testid="mock-accordion-item">{children}</div>
  );
  const AccordionTrigger = ({ children }: { children: ReactNode }) => (
    <div data-testid="mock-accordion-trigger">{children}</div>
  );
  const AccordionContent = ({ children }: { children: ReactNode }) => (
    <div data-testid="mock-accordion-content">{children}</div>
  );

  return {
    Accordion: AccordionRoot,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
  };
});

export const TEST_FOLDER_ID = 'test-folder';

export function createCompositeKey(path: string) {
  // Remove extra backslashes from the template literal
  return `${TEST_FOLDER_ID}|@|${path}`;
}

// Default mocks we often reuse
export const mockOnSelectionChange = vi.fn();
export const mockOnLoadFileContent = vi.fn();

export const defaultProps = {
  selectedFiles: new Set<string>(),
  onSelectionChange: mockOnSelectionChange,
  fileContents: {},
  loadingFiles: new Set<string>(),
  onLoadFileContent: mockOnLoadFileContent,
  fileSizes: {},
};

// Custom render function with providers
function render(ui: ReactElement): RenderResult {
  return testingLibraryRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
        {children}
      </ThemeProvider>
    ),
  });
}

// Re-export test utilities
export { render, screen, userEvent };
