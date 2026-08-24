import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BROWSER_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/browser-pane/availability';
import { CHANGES_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/changes/availability';
import { GIT_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/git-panel/availability';
import { PLATFORM_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/platform-bridge';
import {
  COMMAND_SESSION_BRIDGE_REQUIRED_METHODS,
  TERMINAL_BRIDGE_REQUIRED_METHODS,
} from '@brainstrike/app-shell/terminal-panel/availability';
import { USER_COMMANDS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/user-commands-bridge';
import { ENV_BOOTSTRAP_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import { PROVIDER_AUTH_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/provider-auth';
import { SECRETS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/secrets-bridge';
import { SKILLS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/skills-bridge';
import { NOTES_VAULT_BRIDGE_REQUIRED_METHODS } from '@brainstrike/notes-vault/desktop-contract';
import ts from 'typescript';
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

/**
 * Extract the top-level property names of the object literal passed to
 * `contextBridge.exposeInMainWorld('<bridgeName>', {...})` from the real
 * TypeScript AST. Any property form other than a plain `identifier: value`
 * assignment (spread, computed/quoted key, shorthand, method) throws, so the
 * exposed surface can never silently diverge from what this parity check sees.
 */
function extractExposedBridgeMethodNames(source: string, bridgeName: string): string[] {
  const sourceFile = ts.createSourceFile(
    'preload.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let bridgeObject: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'contextBridge' &&
      node.expression.name.text === 'exposeInMainWorld'
    ) {
      const [nameArgument, apiArgument] = node.arguments;
      if (nameArgument && ts.isStringLiteral(nameArgument) && nameArgument.text === bridgeName) {
        if (bridgeObject) {
          throw new Error(`Multiple exposeInMainWorld('${bridgeName}', ...) calls in preload.`);
        }
        if (!(apiArgument && ts.isObjectLiteralExpression(apiArgument))) {
          throw new Error(
            `exposeInMainWorld('${bridgeName}', ...) is not passed an inline object literal.`
          );
        }
        bridgeObject = apiArgument;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!bridgeObject) {
    throw new Error(`Missing contextBridge.exposeInMainWorld('${bridgeName}', ...) in preload.`);
  }
  return bridgeObject.properties.map((property) => {
    if (!(ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))) {
      throw new Error(
        `Unsupported property form in exposeInMainWorld('${bridgeName}', ...) object ` +
          '(only plain identifier-keyed property assignments are modeled — extend ' +
          'extractExposedBridgeMethodNames).'
      );
    }
    return property.name.text;
  });
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
      "const LOGGING_DURABLE_RECORD_EVENT = 'logging:durable-record'"
    );
    expect(preloadSource).toContain(
      "const DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL = 'desktop-diagnostics:get-snapshot'"
    );
  });

  it('keeps preload logging literals in parity with the platform logging contract', () => {
    const preloadSource = readPreloadSource();

    expect({
      durableRecord: extractPreloadStringConstant(preloadSource, 'LOGGING_DURABLE_RECORD_EVENT'),
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
      APP_LIFECYCLE_NOTE_RELOAD_INTENT_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.runtime.noteReloadIntent,
      APP_POWER_SNAPSHOT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.runtime.powerSnapshot,
      APP_POWER_STATE_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.runtime.powerState,
      ASSISTANT_GET_URL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.agent.assistantGetUrl,
      ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT:
        DESKTOP_PRELOAD_IPC_CHANNELS.agent.previewContextSelectionUpdate,
      ASSISTANT_ROOT_TREE_SELECTION_EVENT:
        DESKTOP_PRELOAD_IPC_CHANNELS.agent.rootTreeSelectionUpdate,
      ASSISTANT_WORKSPACE_CONTEXT_SELECTION_EVENT:
        DESKTOP_PRELOAD_IPC_CHANNELS.agent.workspaceContextSelectionUpdate,
      ASSISTANT_WORKSPACE_CONTEXT_TAPESTRY_EVENT:
        DESKTOP_PRELOAD_IPC_CHANNELS.agent.workspaceContextTapestryUpdate,
      BROWSER_CLOSE_TAB_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.browser.closeTab,
      BROWSER_CREATE_TAB_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.browser.createTab,
      BROWSER_GO_BACK_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.browser.goBack,
      BROWSER_GO_FORWARD_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.browser.goForward,
      BROWSER_LIST_TABS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.browser.listTabs,
      BROWSER_NAVIGATE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.browser.navigate,
      BROWSER_RELOAD_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.browser.reload,
      BROWSER_SELECT_TAB_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.browser.selectTab,
      BROWSER_SET_BOUNDS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.browser.setBounds,
      BROWSER_SET_OCCLUDED_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.browser.setOccluded,
      BROWSER_TABS_CHANGED_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.browser.tabsChanged,
      CHANGES_APPLY_REWIND_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.changes.applyRewind,
      CHANGES_FILE_DIFF_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.changes.fileDiff,
      CHANGES_FINALIZE_REWINDS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.changes.finalizeRewinds,
      CHANGES_INVALIDATED_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.changes.invalidated,
      CHANGES_INVENTORY_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.changes.inventory,
      CHANGES_REDO_REWIND_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.changes.redoRewind,
      CHANGES_RESOLVE_VIEW_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.changes.resolveView,
      CHANGES_REWIND_PREVIEW_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.changes.rewindPreview,
      CLIPBOARD_WRITE_TEXT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.clipboard.writeText,
      COMMAND_SESSIONS_LIST_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.commandSessions.list,
      COMMAND_SESSIONS_READ_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.commandSessions.read,
      COMMAND_SESSIONS_REMOVE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.commandSessions.remove,
      COMMAND_SESSIONS_STOP_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.commandSessions.stop,
      COMMAND_SESSIONS_WRITE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.commandSessions.write,
      DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.applyManagedCacheBatch,
      DB_CLEAR_ALL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.clearAll,
      DB_DIAGNOSTICS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.diagnostics,
      DB_EXEC_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.exec,
      DB_GET_USER_DATA_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.db.getUserDataPath,
      DB_INSERT_CHUNKS_AND_ENQUEUE_JOBS_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.db.insertChunksAndEnqueueEmbeddingJobs,
      DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.db.invalidateManagedCacheEntriesByIdentity,
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
      FILE_EXPORTS_SAVE_TO_DOWNLOADS_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.fileExports.saveToDownloads,
      FILE_SYSTEM_ADD_ROOT_BY_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.addRootByPath,
      FILE_SYSTEM_EXISTS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.exists,
      FILE_SYSTEM_LIST_RECENT_ROOTS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.listRecentRoots,
      FILE_SYSTEM_READ_DIRECTORY_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.readDirectory,
      FILE_SYSTEM_READ_FILE_BY_ABSOLUTE_PATH_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.files.readFileByAbsolutePath,
      FILE_SYSTEM_READ_FILE_BY_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.readFileByPath,
      FILE_SYSTEM_READ_FILE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.readFile,
      FILE_SYSTEM_REQUEST_DIRECTORY_ACCESS_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.files.requestDirectoryAccess,
      FILE_SYSTEM_RESTORE_LAST_FOLDER_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.restoreLastFolder,
      FILE_SYSTEM_SAVE_LAST_FOLDER_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.saveLastFolder,
      FILE_SYSTEM_UNWATCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.unwatch,
      FILE_SYSTEM_WATCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.watch,
      FILE_SYSTEM_WATCH_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.files.watchEvent,
      GIT_AHEAD_BEHIND_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.aheadBehind,
      GIT_COMMIT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.commit,
      GIT_COMMIT_FILES_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.commitFiles,
      GIT_CREATE_BRANCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.createBranch,
      GIT_DIFF_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.diff,
      GIT_FETCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.fetch,
      GIT_HISTORY_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.history,
      GIT_PULL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.pull,
      GIT_PUSH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.push,
      GIT_REPOSITORY_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.repository,
      GIT_STAGE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.stage,
      GIT_STATUS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.status,
      GIT_STRUCTURED_FILE_DIFF_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.structuredFileDiff,
      GIT_SWITCH_BRANCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.switchBranch,
      GIT_UNSTAGE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.unstage,
      LAYOUT_LOAD_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.preferences.layoutLoad,
      LAYOUT_SAVE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.preferences.layoutSave,
      MCP_CONFIG_CREATE_SAMPLE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configCreateSample,
      MCP_CONFIG_GET_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configGet,
      MCP_CONFIG_GET_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configGetPath,
      MCP_CONFIG_READ_TEXT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configReadText,
      MCP_CONFIG_SELECT_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configSelectPath,
      MCP_CONFIG_SET_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configSetPath,
      MCP_CONFIG_UNWATCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configUnwatch,
      MCP_CONFIG_UPDATED_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configUpdated,
      MCP_CONFIG_WATCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configWatch,
      MCP_CONFIG_WRITE_TEXT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.configWriteText,
      MCP_TOOLS_DISABLE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsDisable,
      MCP_TOOLS_DISABLE_SERVER_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsDisableServer,
      MCP_TOOLS_ENABLE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsEnable,
      MCP_TOOLS_ENABLE_SERVER_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsEnableServer,
      MCP_TOOLS_GET_STATS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsGetStats,
      MCP_TOOLS_LIST_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsList,
      MCP_TOOLS_RESET_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsReset,
      MCP_TOOLS_UPDATED_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.mcp.toolsUpdated,
      PARSER_HOST_PARSE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.files.parserHostParse,
      PROVIDER_AUTH_CANCEL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.providerAuth.cancel,
      PROVIDER_AUTH_DISCONNECT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.providerAuth.disconnect,
      PROVIDER_AUTH_START_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.providerAuth.start,
      PROVIDER_AUTH_STATUS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.providerAuth.status,
      RUNTIME_LIST_MODELS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.runtime.listModels,
      RUNTIME_PROBE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.runtime.probe,
      RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.runtime.resolveOllamaCapabilities,
      RUNTIME_VERIFY_EMBEDDING_DIMENSIONS_CHANNEL:
        DESKTOP_PRELOAD_IPC_CHANNELS.runtime.verifyEmbeddingDimensions,
      SECRETS_CLEAR_ALL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.clearAll,
      SECRETS_DELETE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.delete,
      SECRETS_ENV_BOOTSTRAP_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.envBootstrap,
      SECRETS_GET_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.get,
      SECRETS_GET_CREDENTIAL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.getCredential,
      SECRETS_LIST_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.list,
      SECRETS_LIST_STORED_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.listStored,
      SECRETS_SAVE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.save,
      SECRETS_SAVE_CREDENTIAL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.secrets.saveCredential,
      SETTINGS_CLEAR_ALL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.preferences.settingsClearAll,
      SHELL_OPEN_EXTERNAL_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.shell.openExternal,
      SHELL_OPEN_PATH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.shell.openPath,
      SHELL_SHOW_ITEM_IN_FOLDER_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.shell.showItemInFolder,
      STORAGE_CLEAR_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.storage.clear,
      STORAGE_GET_ALL_KEYS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.storage.getAllKeys,
      STORAGE_GET_ITEM_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.storage.getItem,
      STORAGE_REMOVE_ITEM_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.storage.removeItem,
      STORAGE_SET_ITEM_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.storage.setItem,
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

  it('keeps resolver-gated bridge key sets in parity with their required-method contracts', () => {
    const preloadSource = readPreloadSource();
    // Each of these bridges is disabled WHOLESALE by its resolver when any
    // required method is missing from the preload surface, so the exposed key
    // set must match the resolver's required-method list exactly.
    const expectedBridgeMethods: Record<string, readonly string[]> = {
      browser: BROWSER_BRIDGE_REQUIRED_METHODS,
      changes: CHANGES_BRIDGE_REQUIRED_METHODS,
      commandSessions: COMMAND_SESSION_BRIDGE_REQUIRED_METHODS,
      envBootstrap: ENV_BOOTSTRAP_BRIDGE_REQUIRED_METHODS,
      git: GIT_BRIDGE_REQUIRED_METHODS,
      notesVault: NOTES_VAULT_BRIDGE_REQUIRED_METHODS,
      platform: PLATFORM_BRIDGE_REQUIRED_METHODS,
      providerAuth: PROVIDER_AUTH_BRIDGE_REQUIRED_METHODS,
      secrets: SECRETS_BRIDGE_REQUIRED_METHODS,
      skills: SKILLS_BRIDGE_REQUIRED_METHODS,
      terminal: TERMINAL_BRIDGE_REQUIRED_METHODS,
      userCommands: USER_COMMANDS_BRIDGE_REQUIRED_METHODS,
    };

    for (const [bridgeName, requiredMethods] of Object.entries(expectedBridgeMethods)) {
      expect
        .soft({
          bridge: bridgeName,
          methods: [...extractExposedBridgeMethodNames(preloadSource, bridgeName)].sort(),
        })
        .toEqual({ bridge: bridgeName, methods: [...requiredMethods].sort() });
    }
  });

  it('does not call ipcRenderer with raw channel string literals', () => {
    expect(findRawIpcRendererChannels(readPreloadSource())).toEqual([]);
  });

  it('keeps renderer tool execution out of the preload bridge', () => {
    const preloadSource = readPreloadSource();

    expect(extractExposedBridgeMethodNames(preloadSource, 'tools')).not.toContain('execute');
    expect(preloadSource).not.toContain('TOOLS_EXECUTE_CHANNEL');
  });

  it('exposes file explorer test instrumentation before renderer app mount in E2E mode', () => {
    const preloadSource = readPreloadSource();

    expect(preloadSource).toContain('__brainstrike_e2e_expose_file_explorer_store__');
    expect(preloadSource).toContain('if (DESKTOP_TEST_MODE)');
  });
});
