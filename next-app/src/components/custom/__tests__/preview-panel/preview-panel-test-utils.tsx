import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import * as React from 'react';

// Common mocks
jest.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn().mockReturnValue({
      id: 'mock-toast-id',
      dismiss: jest.fn(),
    }),
  }),
}));

// Mock lucide-react icons
jest.mock('lucide-react', () => ({
  Loader2: ({
    className,
    'data-testid': dataTestId,
  }: { className?: string; 'data-testid'?: string }) => (
    <div data-testid={dataTestId} className={className}>
      Loading Icon
    </div>
  ),
  X: ({ className }: { className?: string }) => <div className={className}>Close Icon</div>,
}));

// Mock ResizeObserver globally here
const mockResizeObserver = jest.fn(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}));

beforeAll(() => {
  window.ResizeObserver = mockResizeObserver;
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Mock Radix UI Accordion components
jest.mock('@/components/ui/accordion', () => {
  return {
    Accordion: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
      <div {...props}>{children}</div>
    ),
    AccordionItem: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
      <div {...props}>{children}</div>
    ),
    AccordionTrigger: ({
      children,
      ...props
    }: { children: ReactNode } & Record<string, unknown>) => <div {...props}>{children}</div>,
    AccordionContent: ({
      children,
      ...props
    }: { children: ReactNode } & Record<string, unknown>) => <div {...props}>{children}</div>,
  };
});

export const TEST_FOLDER_ID = 'test-folder';

export function createCompositeKey(path: string) {
  // Remove extra backslashes from the template literal
  return `${TEST_FOLDER_ID}|@|${path}`;
}

// Default mocks we often reuse
export const mockOnSelectionChange = jest.fn();
export const mockOnLoadFileContent = jest.fn();

export const defaultProps = {
  selectedFiles: new Set<string>(),
  onSelectionChange: mockOnSelectionChange,
  fileContents: {},
  loadingFiles: new Set<string>(),
  onLoadFileContent: mockOnLoadFileContent,
  fileSizes: {},
};

// Re-export test utilities
export { render, userEvent };
