import type { useConfiguredAssistantProviders } from '@brainstrike/app-shell';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { useNativeToolPreferencesStore } from '@brainstrike/app-state/stores/native-tool-preferences-store';
import {
  DESKTOP_NATIVE_TOOL_IDS,
  getProviderModelDefinitions,
} from '@brainstrike/assistant-contract';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useDesktopHostPresentation } from '../renderer/use-desktop-host-presentation';

// The provider list is this hook's input (the shared discovery resource owns
// it); slash commands and @-mentions need the explorer and file-system shells
// and take no part in the composer's provider notice.
type ConfiguredProviders = ReturnType<typeof useConfiguredAssistantProviders>;
const configured = vi.hoisted((): { current: ConfiguredProviders } => ({
  current: { discoveryState: 'ready', providers: [] },
}));
vi.mock('@brainstrike/app-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/app-shell')>()),
  useAssistantSlashCommands: () => [],
  useConfiguredAssistantProviders: () => configured.current,
  useFileMentions: () => ({ fileMentions: [] }),
}));
// The catalog rows host admission reads (`models`), as the live query returns them.
interface CatalogRead {
  error: Error | null;
  loading: boolean;
  rows: { id: string; providerId: string }[];
}
const catalog = vi.hoisted((): { current: CatalogRead } => ({
  current: { error: null, loading: false, rows: [] },
}));
// The renderer's open database; its `models` reads go through the live query below.
const DATABASE = { kind: 'database' } as const;
const database = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock('@brainstrike/db/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/db/react')>()),
  usePGliteDatabase: () => database.current,
  usePGliteLiveQuery: (options: { query: string }) => {
    if (!options.query.includes('FROM models')) {
      throw new Error(`Unexpected live query: ${options.query}`);
    }
    return { ...catalog.current, refresh: async () => undefined };
  },
}));

const THREAD = 'host-thread-presentation';
const openAiModel = getProviderModelDefinitions('openai').find((model) => model.type === 'llm');
const localModel = getProviderModelDefinitions('local').find((model) => model.type === 'llm');
if (!(openAiModel && localModel)) {
  throw new Error('The provider catalog lists no OpenAI or built-in local chat model');
}
/** A renderer registry row: the Settings cache, not what admission reads. */
const registryRow = (isEnabled: boolean) => ({
  bestFor: null,
  capabilities: { type: 'llm' as const },
  description: null,
  icon: null,
  id: openAiModel.id,
  isEnabled,
  name: openAiModel.label ?? openAiModel.id,
  parameters: null,
  providerId: 'openai',
  sortOrder: 0,
  tagline: null,
});
const enabledOpenAi = { id: openAiModel.id, providerId: 'openai' };
const OLLAMA_MODEL = 'lfm2.5-thinking:latest';
/** The local runtime catalog as the renderer probes it: Ollama available with one chat model. */
function discoverOllama(): void {
  const checkedAt = Date.now();
  const endpoint = 'http://127.0.0.1:11434';
  const available = { checkedAt, endpoint, latencyMs: 3, state: 'available' } as const;
  const notRunning = { checkedAt, message: 'Not running', state: 'unavailable' } as const;
  useAssistantPreferencesStore.setState({
    getLocalRuntimeModels: async () => ({
      lmstudio: {
        availability: notRunning,
        checkedAt,
        message: 'Not running',
        runtime: 'lmstudio',
        state: 'failed',
      },
      ollama: {
        availability: available,
        checkedAt,
        endpoint,
        freshness: 'live',
        models: [
          {
            capabilities: { embeddings: 'unsupported', llm: true, vision: 'unknown' },
            capabilitySource: 'inferred',
            dimensionsKnown: { state: 'not_applicable' },
            displayName: OLLAMA_MODEL,
            endpoint,
            freshness: 'live',
            modelId: OLLAMA_MODEL,
            modelKey: OLLAMA_MODEL,
            providerId: 'ollama',
            runtime: 'ollama',
            source: 'ollama_api_tags',
          },
        ],
        runtime: 'ollama',
        source: 'ollama_api_tags',
        state: 'loaded_non_empty',
      },
    }),
    getLocalRuntimeStatuses: async () => ({ lmstudio: notRunning, ollama: available }),
  });
}

const preferences = useAssistantPreferencesStore.getState();
const registry = useModelRegistryStore.getState();
const threads = useAssistantThreadStore.getState();

beforeEach(() => {
  database.current = DATABASE;
  // The registry cache counts as loaded, so its loader never reads the stand-in database.
  useModelRegistryStore.setState({ hasLoaded: true });
  useAssistantPreferencesStore.setState({ selectedModel: `openai::${openAiModel.id}` });
});

afterEach(() => {
  useAssistantPreferencesStore.setState(preferences, true);
  useModelRegistryStore.setState(registry, true);
  useAssistantThreadStore.setState(threads, true);
  configured.current = { discoveryState: 'ready', providers: [] };
  catalog.current = { error: null, loading: false, rows: [] };
  database.current = null;
  Reflect.deleteProperty(navigator, 'gpu');
});

describe('the host composer gates a send on the provider notice', () => {
  test('no connected provider', () => {
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBe(
      'Connect an AI provider in Settings → Providers to enable the assistant.'
    );
    expect(result.current.isComposerDisabled).toBe(true);
    expect(() => result.current.readConfiguration(null)).toThrow(
      'Connect an AI provider in Settings → Providers to enable the assistant.'
    );
  });

  test('a connected provider with no model the catalog enables, whatever the registry cache says', () => {
    configured.current = { discoveryState: 'ready', providers: ['openai'] };
    useModelRegistryStore.setState({ models: [registryRow(true)] });
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBe('Enable at least one model for OpenAI to continue.');
    expect(result.current.isComposerDisabled).toBe(true);
  });

  test('a model the catalog enables opens the composer though the registry cache is stale', () => {
    configured.current = { discoveryState: 'ready', providers: ['openai'] };
    useModelRegistryStore.setState({ models: [registryRow(false)] });
    catalog.current = { error: null, loading: false, rows: [enabledOpenAi] };
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBeUndefined();
    expect(result.current.isComposerDisabled).toBeUndefined();
    expect(
      result.current.pickerModels?.map(({ id, providerId }) => `${providerId}::${id}`)
    ).toEqual([`openai::${openAiModel.id}`]);
  });

  test('the built-in local model is enabled by its catalog row, as admission reads it', () => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} });
    configured.current = { discoveryState: 'ready', providers: ['local'] };
    useAssistantPreferencesStore.setState({ selectedModel: `local::${localModel.id}` });
    catalog.current = {
      error: null,
      loading: false,
      rows: [{ id: localModel.id, providerId: 'local' }],
    };
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBeUndefined();
    expect(result.current.isComposerDisabled).toBeUndefined();
  });

  test('a dynamically discovered Ollama model sends without any catalog row', async () => {
    configured.current = { discoveryState: 'ready', providers: ['ollama'] };
    discoverOllama();
    useAssistantPreferencesStore.setState({ selectedModel: `ollama::${OLLAMA_MODEL}` });
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    await waitFor(() => {
      expect(result.current.pickerModels?.some(({ id }) => id === OLLAMA_MODEL)).toBe(true);
    });
    expect(result.current.disabledReason).toBeUndefined();
    expect(result.current.isComposerDisabled).toBeUndefined();
  });

  test('a local runtime discovery has not confirmed is named but never gates the send admission accepts', () => {
    configured.current = { discoveryState: 'ready', providers: ['openai'] };
    useAssistantPreferencesStore.setState({ selectedModel: `ollama::${OLLAMA_MODEL}` });
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBe(
      'The selected local runtime is currently unavailable.'
    );
    expect(result.current.isComposerDisabled).toBeUndefined();
  });

  test('a catalog still loading names nothing, and a failed catalog read gates the send', () => {
    configured.current = { discoveryState: 'ready', providers: ['openai'] };
    database.current = null;
    const noDatabase = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(noDatabase.result.current.disabledReason).toBeUndefined();
    noDatabase.unmount();
    database.current = DATABASE;
    catalog.current = { error: null, loading: true, rows: [] };
    const loading = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(loading.result.current.disabledReason).toBeUndefined();
    loading.unmount();
    catalog.current = {
      error: new Error('relation "models" does not exist'),
      loading: false,
      rows: [],
    };
    const failed = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(failed.result.current.disabledReason).toBe(
      'Could not read the enabled models: relation "models" does not exist'
    );
    expect(failed.result.current.isComposerDisabled).toBe(true);
  });

  test("the host status's credential read failure for the selected provider", () => {
    configured.current = { discoveryState: 'ready', providers: ['openai', 'anthropic'] };
    catalog.current = { error: null, loading: false, rows: [enabledOpenAi] };
    const { result } = renderHook(() =>
      useDesktopHostPresentation(THREAD, { openai: 'The OpenAI key could not be read.' })
    );
    expect(result.current.disabledReason).toBe('The OpenAI key could not be read.');
    expect(result.current.isComposerDisabled).toBe(true);
  });

  test('a failed provider refresh with nothing connected names the refresh', () => {
    configured.current = { discoveryError: 'probe failed', discoveryState: 'error', providers: [] };
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBe(
      'Could not refresh available providers: probe failed'
    );
    expect(result.current.isComposerDisabled).toBe(true);
  });

  test('a failed refresh with a ready provider is shown without gating the send', () => {
    configured.current = {
      discoveryError: 'probe failed',
      discoveryState: 'error',
      providers: ['openai'],
    };
    catalog.current = { error: null, loading: false, rows: [enabledOpenAi] };
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBe(
      'Could not refresh available providers: probe failed'
    );
    expect(result.current.isComposerDisabled).toBeUndefined();
  });

  test('a ready provider and model leave the composer open', () => {
    configured.current = { discoveryState: 'ready', providers: ['openai'] };
    catalog.current = { error: null, loading: false, rows: [enabledOpenAi] };
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBeUndefined();
    expect(result.current.isComposerDisabled).toBeUndefined();
  });
});

describe("the host composer's Tools menu", () => {
  const nativeTools = useNativeToolPreferencesStore.getState();
  const MCP_TOOL = 'docs.search';
  // The menu's share of the preload MCP bridge.
  const mcp = {
    disableTools: vi.fn(),
    enableTools: vi.fn(),
    listTools: vi.fn(),
    onToolsUpdated: vi.fn(),
  };
  beforeEach(() => {
    configured.current = { discoveryState: 'ready', providers: ['openai'] };
    catalog.current = { error: null, loading: false, rows: [enabledOpenAi] };
    // The desktop shell's lifecycle bridge: desktop native tools are offered.
    Object.defineProperty(window, 'desktopLifecycle', { configurable: true, value: {} });
    mcp.disableTools.mockResolvedValue(undefined);
    mcp.enableTools.mockResolvedValue(undefined);
    mcp.listTools.mockResolvedValue({
      docs: [{ description: 'Search the docs', enabled: true, id: MCP_TOOL }],
    });
    mcp.onToolsUpdated.mockReturnValue(() => undefined);
    Object.defineProperty(window, 'mcp', { configurable: true, value: mcp });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopLifecycle');
    Reflect.deleteProperty(window, 'mcp');
    vi.clearAllMocks();
    useNativeToolPreferencesStore.setState(nativeTools, true);
  });

  test('lists the desktop native tools and the MCP tools host runs bind, as toggles', async () => {
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    await waitFor(() => {
      expect(result.current.toolMenu?.items.some((tool) => tool.id === MCP_TOOL)).toBe(true);
    });
    const menu = result.current.toolMenu;
    expect(menu?.items.filter((tool) => tool.source === 'native').map((tool) => tool.id)).toEqual(
      DESKTOP_NATIVE_TOOL_IDS
    );
    // Host runs bind MCP tools: no legacy "new threads only" notice, no disabled row.
    const mcpTool = menu?.items.find((tool) => tool.id === MCP_TOOL);
    expect(mcpTool).toMatchObject({ description: 'Search the docs', enabled: true, group: 'docs' });
    expect(mcpTool?.disabled).toBeUndefined();
    const total = DESKTOP_NATIVE_TOOL_IDS.length + 1;
    expect(menu?.summary).toBe(`${total} of ${total} enabled`);
    expect(menu?.onRefresh).toBeTypeOf('function');
    expect(menu?.onOpenSettings).toBeTypeOf('function');
  });

  test('a toggle saves the preference the next send captures', async () => {
    const [nativeTool] = DESKTOP_NATIVE_TOOL_IDS;
    if (!nativeTool) {
      throw new Error('No desktop native tool');
    }
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    await waitFor(() => {
      expect(result.current.toolMenu?.items.some((tool) => tool.id === MCP_TOOL)).toBe(true);
    });
    await act(async () => {
      await result.current.toolMenu?.onToggleTool?.(nativeTool, false);
      await result.current.toolMenu?.onToggleTool?.(MCP_TOOL, false);
    });
    expect(useNativeToolPreferencesStore.getState().isToolEnabled(nativeTool)).toBe(false);
    expect(mcp.disableTools).toHaveBeenCalledWith([MCP_TOOL]);
    expect(result.current.readConfiguration(null)['enabledNativeToolIds']).toEqual(
      DESKTOP_NATIVE_TOOL_IDS.filter((id) => id !== nativeTool)
    );
  });
});
