import { vi } from 'vitest';

// Mock the useToast hook from the UI package
export const mockToast = vi.fn();
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...originalModule,
    useToast: () => ({ toast: mockToast }),
  };
});
