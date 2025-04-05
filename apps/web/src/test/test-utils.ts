import { vi } from 'vitest';

// Simple reset for all mocks
export const resetAllMocks = () => {
  vi.clearAllMocks();
};

// Simple empty reset function since our tests now manage their own state
export const resetStore = () => {
  // Each test now handles its own mocks and state
};
