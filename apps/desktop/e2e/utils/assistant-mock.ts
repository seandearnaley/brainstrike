import { readBoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { SecretsWriteResult } from '@brainstrike/assistant-contract/secrets-bridge';
import type { Page } from '@playwright/test';

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-3.8-flash',
  openai: 'gpt-5.4',
  openrouter: 'openai/gpt-5.4',
} as const;

export interface AssistantMockOptions {
  readonly apiKey?: string;
  /** `provider::model` selected via the desktop test hooks after install. */
  readonly compositeModelKey?: string;
  readonly models?: Record<string, string>;
  readonly provider?: string;
}

export interface AssistantProviderOptions {
  readonly apiKey?: string;
  readonly compositeModelKey?: string;
  readonly provider?: string;
}

const defaultOptions: Required<AssistantMockOptions> = {
  apiKey: 'test-api-key-for-e2e-tests',
  compositeModelKey: 'openai::gpt-5.2',
  models: DEFAULT_MODELS,
  provider: 'openai',
};

interface AssistantProviderInstallPayload {
  readonly apiKey: string;
  readonly compositeModelKey: string;
  readonly ignoreStorageErrors: boolean;
  readonly models: Record<string, string>;
  readonly provider: string;
}

function configureAssistantProviderInPage(payload: AssistantProviderInstallPayload): void {
  const assistantAvailabilityOverrideEvent = 'brainstrike:assistant-availability-override-changed';
  const globals = globalThis as unknown as Window & {
    __assistantAvailabilityOverride?: { state: 'enabled' };
    __brainstrikeAssistantRuntimeTestHooks__?: {
      setCurrentThreadModel: (compositeKey: string) => void;
    };
    __brainstrikeTestHooks__?: {
      notifySecretsChanged: () => void;
      setAssistantModel: (compositeKey: string) => void;
    };
    localStorage?: Storage;
  };
  try {
    globals.localStorage?.setItem(
      'assistant-preferences.v1',
      JSON.stringify({
        state: {
          modelsByProvider: payload.models,
          selectedProvider: payload.provider,
        },
        version: 1,
      })
    );
  } catch (error) {
    if (!payload.ignoreStorageErrors) {
      throw error;
    }
    // Preserve setupAssistantMock's existing tolerance for constrained storage.
  }
  globals.__assistantAvailabilityOverride = { state: 'enabled' };
  globals.dispatchEvent(new Event(assistantAvailabilityOverrideEvent));
  // The key saved above is what the real `secrets.list` now reports; the
  // preload's `secrets` bridge is read-only, so a page script cannot stand in
  // for it.

  const hooks = globals.__brainstrikeTestHooks__;
  if (!hooks) {
    throw new Error('Brainstrike desktop test hooks are unavailable.');
  }
  hooks.notifySecretsChanged();
  hooks.setAssistantModel(payload.compositeModelKey);
  globals.__brainstrikeAssistantRuntimeTestHooks__?.setCurrentThreadModel(
    payload.compositeModelKey
  );
}

async function configureAssistantProviderWithModels(
  page: Page,
  payload: AssistantProviderInstallPayload
): Promise<void> {
  // Electron 43's V8 inspector weakly owns awaited evaluation results. Keep
  // the actual write reachable through a remote object until it settles;
  // retaining only an async wrapper does not retain its awaited promise.
  const pendingWrite = await page.evaluateHandle(
    ({ apiKey, provider }) => {
      const secrets = (
        globalThis as unknown as {
          secrets?: { saveKey?: (provider: string, key: string) => Promise<SecretsWriteResult> };
        }
      ).secrets;
      if (typeof secrets?.saveKey !== 'function') {
        throw new Error('Desktop secrets.saveKey is unavailable.');
      }
      const write = secrets.saveKey(provider, apiKey);
      // Observe rejection in the same turn as invocation. Waiting until the
      // next CDP command would briefly leave an immediate rejection unhandled.
      const completion = write.then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ error, ok: false }) as const
      );
      // A derived completion promise alone does not keep its source alive.
      return { completion, write };
    },
    { apiKey: payload.apiKey, provider: payload.provider }
  );
  try {
    await pendingWrite.evaluate(async ({ completion }) => {
      const result = await completion;
      if (!result.ok) {
        throw result.error;
      }
      if (result.value !== true) {
        throw new Error(`Assistant provider key save failed: ${result.value.error}`);
      }
    });
  } finally {
    await pendingWrite.dispose();
  }
  await page.evaluate(configureAssistantProviderInPage, payload);
}

/**
 * Enables the catalog row Main admits for a `provider::model` selection. The
 * committed host admission refuses a disabled row, and renderer selection alone
 * does not enable it (precedent: mcp-packaged-core.desktop.test.ts).
 *
 * BST-2242: the write goes through the renderer's catalog store, as Settings
 * and the picker's Enable do. The composer's picker and its admission re-read
 * follow that store, so a raw `window.modelCatalog` write commits unseen.
 */
export async function enableAssistantCatalogModel(
  page: Page,
  compositeModelKey: string
): Promise<void> {
  const separator = compositeModelKey.indexOf('::');
  const provider = compositeModelKey.slice(0, separator);
  const model = compositeModelKey.slice(separator + 2);
  await page.evaluate(async (modelId) => {
    const hooks = (
      window as Window & {
        __brainstrikeTestHooks__?: {
          enableCatalogModels?: (modelIds: readonly string[]) => Promise<void>;
        };
      }
    ).__brainstrikeTestHooks__;
    if (!hooks?.enableCatalogModels) {
      throw new Error('The desktop catalog enable test hook is unavailable');
    }
    await hooks.enableCatalogModels([modelId]);
  }, model);
  const after = readBoundaryResult(
    await page.evaluate(async () => {
      const catalog = window.modelCatalog;
      if (!catalog) {
        throw new Error('The desktop model catalog capability is unavailable');
      }
      return await catalog.read();
    })
  );
  const rows = after.models.filter((row) => row.id === model && row.providerId === provider);
  const [row] = rows;
  const enabled =
    rows.length === 1 &&
    row?.['id'] === model &&
    row['providerId'] === provider &&
    row['isEnabled'] === true;
  if (!enabled) {
    throw new Error(`Catalog row ${compositeModelKey} was not enabled: ${JSON.stringify(rows)}`);
  }
}

/**
 * Configures the real assistant provider/key/model seams. Use this when an E2E
 * needs the real host-side Mastra loop and native-tool execution.
 */
export async function configureAssistantProvider(
  page: Page,
  options: AssistantProviderOptions = {}
): Promise<void> {
  const provider = options.provider ?? defaultOptions.provider;
  const defaultModel = DEFAULT_MODELS[provider];
  const compositeModelKey =
    options.compositeModelKey ??
    (provider === defaultOptions.provider
      ? defaultOptions.compositeModelKey
      : defaultModel
        ? `${provider}::${defaultModel}`
        : undefined);
  if (!compositeModelKey) {
    throw new Error(`No default assistant model is configured for provider "${provider}".`);
  }
  await configureAssistantProviderWithModels(page, {
    apiKey: options.apiKey ?? defaultOptions.apiKey,
    compositeModelKey,
    ignoreStorageErrors: false,
    models: DEFAULT_MODELS,
    provider,
  });
}

/**
 * Saves a fake provider key and selects a model the way `configureAssistantProvider`
 * does, tolerating renderer storage that refuses the preference write.
 */
export async function setupAssistantMock(
  page: Page,
  options?: AssistantMockOptions
): Promise<void> {
  const merged = { ...defaultOptions, ...options };
  await configureAssistantProviderWithModels(page, {
    apiKey: merged.apiKey,
    compositeModelKey: merged.compositeModelKey,
    ignoreStorageErrors: true,
    models: merged.models,
    provider: merged.provider,
  });
}
