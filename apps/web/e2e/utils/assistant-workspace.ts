import type { ModelRegistrySnapshotOverride } from '@brainstrike/preferences/settings-test-runtime-access';
import { ASSISTANT_PREFERENCES_STORE_VERSION } from '@brainstrike/preferences/stores/assistant-preferences-store';
import { expect, type Page } from '@playwright/test';
import { resetAppState } from './app-state';
import { waitForAppLoad } from './layout-helpers';
import { type FileTree, mockBrowserApis } from './mock-fs';

const LOCAL_ASSISTANT_MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';

interface AssistantWorkspaceOptions {
  readonly clipboard?: boolean;
  readonly enableLocalAssistantModel?: boolean;
  readonly rootName?: string;
  readonly tree?: FileTree;
}

const DEFAULT_ASSISTANT_TREE: FileTree = {
  'README.md': '# Assistant workspace fixture',
};

interface LocalAssistantModelFixture {
  readonly assistantPreferences: {
    readonly state: {
      readonly enabledModelsByProvider: { readonly local: readonly string[] };
      readonly modelsByProvider: { readonly local: string };
      readonly providerSettings: {
        readonly lmstudio: { readonly localRuntimeEnabled: 'off' };
        readonly ollama: { readonly localRuntimeEnabled: 'off' };
      };
      readonly selectedModel: string;
      readonly selectedProvider: 'local';
    };
    readonly version: number;
  };
  readonly modelRegistrySnapshot: ModelRegistrySnapshotOverride;
}

function createLocalAssistantModelFixture(): LocalAssistantModelFixture {
  const selectedModel = `local::${LOCAL_ASSISTANT_MODEL_ID}`;

  return {
    assistantPreferences: {
      state: {
        enabledModelsByProvider: { local: [LOCAL_ASSISTANT_MODEL_ID] },
        modelsByProvider: { local: LOCAL_ASSISTANT_MODEL_ID },
        providerSettings: {
          lmstudio: { localRuntimeEnabled: 'off' },
          ollama: { localRuntimeEnabled: 'off' },
        },
        selectedProvider: 'local',
        selectedModel,
      },
      version: ASSISTANT_PREFERENCES_STORE_VERSION,
    },
    modelRegistrySnapshot: {
      downloadedModels: { [LOCAL_ASSISTANT_MODEL_ID]: true },
      models: [
        {
          bestFor: ['assistant'],
          capabilities: { type: 'llm', streaming: false },
          description: 'Mocked local assistant model for E2E tests',
          icon: null,
          id: LOCAL_ASSISTANT_MODEL_ID,
          isEnabled: true,
          name: 'Gemma 4 E2B',
          parameters: null,
          providerId: 'local',
          sortOrder: 0,
          tagline: 'E2E local assistant model',
        },
      ],
      providers: [
        {
          icon: null,
          id: 'local',
          isEnabled: true,
          name: 'Local (Browser)',
          sortOrder: 0,
        },
      ],
    },
  };
}

export async function openAssistantWorkspace(
  page: Page,
  options: AssistantWorkspaceOptions = {}
): Promise<void> {
  if (options.enableLocalAssistantModel === true) {
    await page.addInitScript((fixture: LocalAssistantModelFixture) => {
      const { assistantPreferences, modelRegistrySnapshot } = fixture;

      // Runtime signals: explicit opt-in for automated settings hooks.
      Object.defineProperty(navigator, 'webdriver', {
        configurable: true,
        get: () => true,
      });

      if (!('gpu' in navigator)) {
        Object.defineProperty(navigator, 'gpu', {
          configurable: true,
          value: {
            async requestAdapter() {
              return {
                info: {
                  architecture: 'test',
                  description: 'Mock WebGPU adapter for assistant E2E tests',
                  device: 'mock-webgpu',
                  vendor: 'playwright',
                },
                limits: {
                  maxBufferSize: 1_073_741_824,
                  maxStorageBufferBindingSize: 1_073_741_824,
                },
              };
            },
          },
        });
      }

      // Persisted preferences: select the mocked browser-local assistant model.
      const browserWindow = window as Window & {
        assistant?: {
          getUrl: () => Promise<string>;
          url: string;
        };
        secrets?: {
          getKey: () => Promise<null>;
          list: () => Promise<string[]>;
        };
      };
      window.localStorage.setItem('assistant-preferences.v1', JSON.stringify(assistantPreferences));

      // Desktop bridge stubs: satisfy assistant setup without hosted provider keys.
      browserWindow.assistant = {
        getUrl: async () => 'http://127.0.0.1:0',
        url: 'http://127.0.0.1:0',
      };
      browserWindow.secrets = {
        getKey: async () => null,
        list: async () => ['local'],
      };

      // Settings override API: seed registry/provider state before React mounts.
      window.__brainstrike_e2e_enable_settings_test_api__ = true;
      window.__brainstrikePendingSettingsTestOverrides__ = {
        accurateRuntimeAvailable: true,
        assistant: {
          configuredProviders: ['local'],
        },
        modelRegistry: {
          snapshot: modelRegistrySnapshot,
        },
      };
    }, createLocalAssistantModelFixture());
  }

  await mockBrowserApis(
    page,
    options.rootName ?? 'assistant-workspace',
    options.tree ?? DEFAULT_ASSISTANT_TREE,
    { clipboard: options.clipboard ?? false }
  );

  await page.goto('/');
  await waitForAppLoad(page, { waitForDatabase: false });
  await resetAppState(page);
  await page.reload({ waitUntil: 'load' });
  await waitForAppLoad(page);

  const selectRootButton = page.getByRole('button', { name: /^Select Root$/i });
  if (await selectRootButton.isVisible().catch(() => false)) {
    await selectRootButton.click();
  }

  await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible({
    timeout: 15_000,
  });

  if (options.enableLocalAssistantModel === true) {
    await expect(page.locator('#assistant-input')).toBeEnabled({ timeout: 15_000 });
  }
}
