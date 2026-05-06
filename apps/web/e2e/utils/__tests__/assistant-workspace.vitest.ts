import type { Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppState } from '../app-state';
import { openAssistantWorkspace } from '../assistant-workspace';
import { waitForAppLoad } from '../layout-helpers';
import { mockBrowserApis } from '../mock-fs';

vi.mock('@playwright/test', () => ({
  expect: vi.fn(() => ({
    toBeEnabled: vi.fn().mockResolvedValue(undefined),
    toBeVisible: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../app-state', () => ({
  resetAppState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../layout-helpers', () => ({
  waitForAppLoad: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../mock-fs', () => ({
  mockBrowserApis: vi.fn().mockResolvedValue(undefined),
}));

interface MockButton {
  readonly click: ReturnType<typeof vi.fn>;
  readonly isVisible: ReturnType<typeof vi.fn>;
}

interface MockPage extends Page {
  readonly selectRootButton: MockButton;
}

function createPage(): MockPage {
  const selectRootButton: MockButton = {
    click: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(false),
  };

  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    getByRole: vi.fn(() => selectRootButton),
    getByTestId: vi.fn((testId: string) => ({ testId })),
    goto: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn((selector: string) => ({ selector })),
    reload: vi.fn().mockResolvedValue(undefined),
    selectRootButton,
  } as unknown as MockPage;
}

describe('openAssistantWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for database readiness after reset because assistant threads are DB-backed', async () => {
    const page = createPage();

    await openAssistantWorkspace(page);

    expect(mockBrowserApis).toHaveBeenCalledWith(
      page,
      'assistant-workspace',
      { 'README.md': '# Assistant workspace fixture' },
      { clipboard: false }
    );
    expect(page.goto).toHaveBeenCalledWith('/');
    expect(resetAppState).toHaveBeenCalledWith(page);
    expect(page.reload).toHaveBeenCalledWith({ waitUntil: 'load' });
    expect(waitForAppLoad).toHaveBeenNthCalledWith(1, page, { waitForDatabase: false });
    expect(waitForAppLoad).toHaveBeenNthCalledWith(2, page, { waitForDatabase: true });
  });
});
