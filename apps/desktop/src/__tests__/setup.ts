import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock Electron APIs
const mockElectronAPI = {
  storage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getAllKeys: vi.fn().mockResolvedValue([]),
  },
  fileSystem: {
    requestDirectoryAccess: vi.fn().mockResolvedValue({
      path: '/mock/path',
      name: 'mock-directory',
      kind: 'directory',
      platform: 'electron',
    }),
    readDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue('mock file content'),
    exists: vi.fn().mockResolvedValue(true),
    restoreLastFolder: vi.fn().mockResolvedValue(null),
    saveLastFolder: vi.fn().mockResolvedValue(undefined),
  },
  getUserDataPath: vi.fn().mockResolvedValue('/mock/user/data'),
};

// Mock window.electronAPI
Object.defineProperty(window, 'electronAPI', {
  value: mockElectronAPI,
  writable: true,
});

// Mock window.secrets
const mockSecrets = {
  saveKey: vi.fn().mockResolvedValue(true as const),
  getKey: vi.fn().mockResolvedValue(null as string | null),
  deleteKey: vi.fn().mockResolvedValue(true),
  list: vi.fn().mockResolvedValue([] as string[]),
};
Object.defineProperty(window, 'secrets', {
  value: mockSecrets,
  writable: true,
});

// Mock window.agent
const mockAgent = {
  chat: vi.fn().mockResolvedValue([
    { type: 'tool-event', name: 'plan', status: 'start' },
    { type: 'text-delta', value: 'Hello' },
    { type: 'text-delta', value: ' world' },
    { type: 'tool-event', name: 'plan', status: 'success' },
  ]),
};
Object.defineProperty(window, 'agent', {
  value: mockAgent,
  writable: true,
});

// Mock react-router-dom for components that use it
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/' }),
    BrowserRouter: ({ children }: { children: React.ReactNode }) => children,
    Routes: ({ children }: { children: React.ReactNode }) => children,
    Route: ({ children }: { children: React.ReactNode }) => children,
  };
});

// Export mocks for use in tests
export { mockElectronAPI };
