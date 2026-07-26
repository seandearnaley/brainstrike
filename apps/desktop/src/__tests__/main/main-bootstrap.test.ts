import { expect, it, vi } from 'vitest';

const bootstrapEvents = vi.hoisted(() => [] as string[]);
const initializeDesktopEnvironment = vi.hoisted(() =>
  vi.fn(() => {
    bootstrapEvents.push('environment');
  })
);

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getAppPath: vi.fn(() => '/mock/app'),
    getPath: vi.fn(() => '/mock/user-data'),
    isPackaged: false,
  },
  dialog: { showErrorBox: vi.fn() },
}));

vi.mock('../../desktop-env', () => ({ initializeDesktopEnvironment }));

vi.mock('../../main', () => {
  bootstrapEvents.push('main');
  return {};
});

it('initializes desktop environment files before evaluating the main runtime graph', async () => {
  await import('../../main-bootstrap');
  await vi.waitFor(() => {
    expect(bootstrapEvents).toEqual(['environment', 'main']);
  });
});
