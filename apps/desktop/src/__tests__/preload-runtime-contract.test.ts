import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { LOGGING_API_CHANNELS } from '../platform/logging-api-contract';

function readPreloadSource(): string {
  return readFileSync(path.resolve(process.cwd(), 'src', 'preload.ts'), 'utf8');
}

function extractPreloadStringConstant(source: string, constantName: string): string {
  const escapedConstantName = constantName.replaceAll('$', String.raw`\$`);
  const match = source.match(
    new RegExp(String.raw`const\s+${escapedConstantName}\s*=\s*['"]([^'"]+)['"]\s+as\s+const`)
  );
  if (!match?.[1]) {
    throw new Error(`Missing preload constant ${constantName}.`);
  }
  return match[1];
}

function removePreloadStringConstantDefinitions(source: string): string {
  return source.replaceAll(
    /const\s+[A-Z0-9_]+_(?:CHANNEL|EVENT)\s*=\s*['"][^'"]+['"]\s+as\s+const;/g,
    ''
  );
}

function findRawIpcRendererChannels(source: string): string[] {
  const pattern = /ipcRenderer\.(?:invoke|send|on|removeListener)\(\s*['"][^'"]+['"]/g;
  return [...source.matchAll(pattern)].map((match) => {
    const lineNumber = source.slice(0, match.index).split('\n').length;
    return `${lineNumber}: ${match[0]}`;
  });
}

describe('preload runtime contract', () => {
  it('keeps preload IPC contracts self-contained', () => {
    const preloadSource = readPreloadSource();

    expect(preloadSource).not.toContain("from './db-shared'");
    expect(preloadSource).not.toContain("from './platform/logging-api-contract'");
    expect(preloadSource).toContain(
      "const DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL = 'db:managed-cache:apply-batch'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_GET_PREFERENCES_CHANNEL = 'logging:get-preferences'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_SET_PREFERENCES_CHANNEL = 'logging:set-preferences'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_SELECT_DESTINATION_CHANNEL = 'logging:select-destination'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_OPEN_DESTINATION_CHANNEL = 'logging:open-destination'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_GET_BUFFERED_LOGS_CHANNEL = 'logging:get-buffered-logs'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_INGEST_BUFFERED_RECORD_CHANNEL = 'logging:ingest-buffered-record'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_PREFERENCES_UPDATED_EVENT = 'logging:preferences-updated'"
    );
    expect(preloadSource).toContain(
      "const DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL = 'desktop-diagnostics:get-snapshot'"
    );
  });

  it('keeps preload logging literals in parity with the platform logging contract', () => {
    const preloadSource = readPreloadSource();

    expect({
      getBufferedLogs: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_GET_BUFFERED_LOGS_CHANNEL'
      ),
      getPreferences: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_GET_PREFERENCES_CHANNEL'
      ),
      ingestBufferedRecord: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_INGEST_BUFFERED_RECORD_CHANNEL'
      ),
      openDestination: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_OPEN_DESTINATION_CHANNEL'
      ),
      preferencesUpdated: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_PREFERENCES_UPDATED_EVENT'
      ),
      selectDestination: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_SELECT_DESTINATION_CHANNEL'
      ),
      setPreferences: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_SET_PREFERENCES_CHANNEL'
      ),
    }).toEqual(LOGGING_API_CHANNELS);

    const preloadWithoutConstantDefinitions = preloadSource.replaceAll(
      /const\s+LOGGING_[A-Z_]+_(?:CHANNEL|EVENT)\s*=\s*['"]logging:[^'"]+['"]\s+as\s+const;/g,
      ''
    );
    expect(preloadWithoutConstantDefinitions).not.toMatch(/['"]logging:[^'"]+['"]/);
  });

  it('keeps deterministic E2E local-runtime bridge responses in preload', () => {
    const preloadSource = readPreloadSource();

    expect(preloadSource).toContain('BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES');
    expect(preloadSource).toContain('createDisabledLocalRuntimeAvailability');
    expect(preloadSource).toContain('createDisabledLocalRuntimeCatalog');
  });

  it('keeps preload desktop diagnostics literal in parity with the platform diagnostics contract', () => {
    const preloadSource = readPreloadSource();

    expect(
      extractPreloadStringConstant(preloadSource, 'DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL')
    ).toBe(DESKTOP_PRELOAD_IPC_CHANNELS.diagnostics.getSnapshot);
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('desktopDiagnostics'");
  });

  it('keeps preload bridge channel literals in parity with the desktop IPC channel catalog', () => {
    const preloadSource = readPreloadSource();
    const expectedConstants = {
      AGENT_CHAT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.agent.chat,
      ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT:
        DESKTOP_PRELOAD_IPC_CHANNELS.agent.previewContextSelectionUpdate,
      APP_POWER_STATE_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.runtime.powerState,
      APP_POWER_SNAPSHOT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.runtime.powerSnapshot,
      ASSISTANT_GET_URL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.agent.assistantGetUrl,
      ASSISTANT_ROOT_TREE_SELECTION_EVENT:
        DESKTOP_PRELOAD_IPC_CHANNELS.agent.rootTreeSelectionUpdate,
      ASSISTANT_WORKSPACE_CONTEXT_SELECTION_EVENT:
        DESKTOP_PRELOAD_IPC_CHANNELS.agent.workspaceContextSelectionUpdate,
      ASSISTANT_WORKSPACE_CONTEXT_TAPESTRY_EVENT:
        DESKTOP_PRELOAD_IPC_CHANNELS.agent.workspaceContextTapestryUpdate,
      APP_LIFECYCLE_NOTE_RELOAD_INTENT_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.runtime.noteReloadIntent,
      DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.applyManagedCacheBatch,
      DB_CLEAR_ALL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.clearAll,
      DB_DIAGNOSTICS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.diagnostics,
      DB_EXEC_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.exec,
      DB_GET_USER_DATA_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.getUserDataPath,
      DB_LIVE_QUERY_REFRESH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.liveQueryRefresh,
      DB_LIVE_QUERY_START_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.liveQueryStart,
      DB_LIVE_QUERY_STOP_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.liveQueryStop,
      DB_LIVE_QUERY_UPDATE_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.db.liveQueryUpdate,
      DB_PING_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.ping,
      DB_QUERY_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.query,
      DB_RESET_LOCAL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.resetLocal,
      DB_SCHEDULER_SNAPSHOT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.schedulerSnapshot,
      DB_TEST_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.test,
      DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.diagnostics.getSnapshot,
      FILE_SYSTEM_EXISTS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.exists,
      FILE_SYSTEM_READ_DIRECTORY_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.readDirectory,
      FILE_SYSTEM_READ_FILE_BY_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.readFileByPath,
      FILE_SYSTEM_READ_FILE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.readFile,
      FILE_SYSTEM_REQUEST_DIRECTORY_ACCESS_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.files.requestDirectoryAccess,
      FILE_SYSTEM_RESTORE_LAST_FOLDER_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.restoreLastFolder,
      FILE_SYSTEM_SAVE_LAST_FOLDER_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.saveLastFolder,
      LAYOUT_LOAD_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.preferences.layoutLoad,
      LAYOUT_SAVE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.preferences.layoutSave,
      MCP_CONFIG_CREATE_SAMPLE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configCreateSample,
      MCP_CONFIG_GET_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configGet,
      MCP_CONFIG_GET_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configGetPath,
      MCP_CONFIG_READ_TEXT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configReadText,
      MCP_CONFIG_SELECT_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configSelectPath,
      MCP_CONFIG_SET_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configSetPath,
      MCP_CONFIG_WATCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configWatch,
      MCP_CONFIG_WRITE_TEXT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configWriteText,
      MCP_CONFIG_UNWATCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configUnwatch,
      MCP_TOOLS_DISABLE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsDisable,
      MCP_TOOLS_DISABLE_SERVER_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsDisableServer,
      MCP_TOOLS_ENABLE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsEnable,
      MCP_TOOLS_ENABLE_SERVER_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsEnableServer,
      MCP_TOOLS_GET_STATS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsGetStats,
      MCP_TOOLS_LIST_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsList,
      MCP_TOOLS_RESET_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsReset,
      MCP_TOOLS_UPDATED_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsUpdated,
      PARSER_HOST_PARSE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.parserHostParse,
      RUNTIME_LIST_MODELS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.runtime.listModels,
      RUNTIME_PROBE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.runtime.probe,
      RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.runtime.resolveOllamaCapabilities,
      RUNTIME_VERIFY_EMBEDDING_DIMENSIONS_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.runtime.verifyEmbeddingDimensions,
      SECRETS_CLEAR_ALL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.clearAll,
      SECRETS_DELETE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.delete,
      SECRETS_GET_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.get,
      SECRETS_LIST_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.list,
      SECRETS_LIST_STORED_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.listStored,
      SECRETS_SAVE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.save,
      SETTINGS_CLEAR_ALL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.preferences.settingsClearAll,
      SHELL_OPEN_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.shell.openPath,
      SHELL_SHOW_ITEM_IN_FOLDER_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.shell.showItemInFolder,
      STORAGE_CLEAR_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.storage.clear,
      STORAGE_GET_ALL_KEYS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.storage.getAllKeys,
      STORAGE_GET_ITEM_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.storage.getItem,
      STORAGE_REMOVE_ITEM_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.storage.removeItem,
      STORAGE_SET_ITEM_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.storage.setItem,
      TOOLS_EXECUTE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.tools.execute,
    } as const;

    for (const [constantName, channel] of Object.entries(expectedConstants)) {
      expect(extractPreloadStringConstant(preloadSource, constantName)).toBe(channel);
    }

    const preloadWithoutContractDefinitions = removePreloadStringConstantDefinitions(preloadSource);
    for (const channel of Object.values(expectedConstants)) {
      expect(preloadWithoutContractDefinitions).not.toContain(`'${channel}'`);
      expect(preloadWithoutContractDefinitions).not.toContain(`"${channel}"`);
    }
  });

  it('does not call ipcRenderer with raw channel string literals', () => {
    expect(findRawIpcRendererChannels(readPreloadSource())).toEqual([]);
  });

  it('exposes file explorer test instrumentation before renderer app mount in E2E mode', () => {
    const preloadSource = readPreloadSource();

    expect(preloadSource).toContain('__brainstrike_e2e_expose_file_explorer_store__');
    expect(preloadSource).toContain('if (DESKTOP_TEST_MODE)');
  });
});
