import { createSafeJsonStorageAdapter } from '@brainstrike/utils/safe-storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export type ToolsPanelTab = 'assistant' | 'database';

const DEFAULT_TAB = 'assistant' as const;
const VALID_TABS = new Set<ToolsPanelTab>([DEFAULT_TAB, 'database']);

interface ToolsPanelData {
  activeTab: ToolsPanelTab;
}

interface ToolsPanelActions {
  setActiveTab: (tab: ToolsPanelTab) => void;
}

export type ToolsPanelStore = ToolsPanelData & ToolsPanelActions;

const LEGACY_STORE_NAME = 'right-panel.v1' as const;
const STORE_NAME = 'tools-panel.v1' as const;
const STORE_VERSION = 2 as const;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 * Uses safe storage utility with proper error logging
 */
const storageAdapter = createSafeJsonStorageAdapter();

function migrateLegacyRightPanelStorage(adapter: ReturnType<typeof createSafeJsonStorageAdapter>) {
  try {
    if (adapter.getItem(STORE_NAME)) {
      return;
    }

    const legacyState = adapter.getItem(LEGACY_STORE_NAME);
    if (!legacyState) {
      return;
    }

    adapter.setItem(STORE_NAME, legacyState);
    adapter.removeItem(LEGACY_STORE_NAME);
  } catch {
    // Intentionally ignore migration failures to avoid blocking store init.
  }
}

migrateLegacyRightPanelStorage(storageAdapter);

const storage = createJSONStorage(() => storageAdapter);

export function sanitizeToolsPanelTab(value: unknown): ToolsPanelTab {
  return typeof value === 'string' && VALID_TABS.has(value as ToolsPanelTab)
    ? (value as ToolsPanelTab)
    : DEFAULT_TAB;
}

export const useToolsPanelStore = create<ToolsPanelStore>()(
  persist(
    (set) => ({
      activeTab: DEFAULT_TAB,
      setActiveTab: (tab) => set({ activeTab: sanitizeToolsPanelTab(tab) }),
    }),
    {
      name: STORE_NAME,
      version: STORE_VERSION,
      storage,
      partialize: (s) => ({ activeTab: s.activeTab }),
      migrate: (persistedState) => {
        const state = persistedState as { activeTab?: unknown } | undefined;
        return {
          activeTab: sanitizeToolsPanelTab(state?.activeTab),
        };
      },
    }
  )
);

export const toolsPanelSelectors = {
  activeTab: (s: ToolsPanelStore) => s.activeTab as ToolsPanelTab,
};

// Test-only helper to reset store and storage
export function __resetToolsPanelStoreForTests() {
  try {
    const persistApi = (
      useToolsPanelStore as unknown as {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
    storageAdapter.removeItem(LEGACY_STORE_NAME);
  } catch {
    // Intentionally silent in tests - storage errors should not fail test resets.
  }
  useToolsPanelStore.setState({ activeTab: DEFAULT_TAB });
}
