import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BROWSER_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/browser-pane/availability';
import { PLATFORM_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/platform-bridge';
import { WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/workspace-connect/workspace-connect-bridge';
import { ENV_BOOTSTRAP_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import { PROVIDER_AUTH_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/provider-auth';
import { SECRETS_BRIDGE_REQUIRED_METHODS } from '@brainstrike/assistant-contract/secrets-bridge';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';

function readPreloadSource(): string {
  return readFileSync(path.resolve(import.meta.dirname, '../preload.ts'), 'utf8');
}

/**
 * Extract the top-level property names of the object literal passed to
 * `contextBridge.exposeInMainWorld('<bridgeName>', {...})` from the real
 * TypeScript AST. Any property form other than a plain `identifier: value`
 * assignment (spread, computed/quoted key, shorthand, method) throws, so the
 * exposed surface can never silently diverge from what this parity check sees.
 */
function extractExposedBridgeProperties(source: string, bridgeName: string): Map<string, string> {
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
  return new Map(
    bridgeObject.properties.map((property) => {
      if (!(ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))) {
        throw new Error(
          `Unsupported property form in exposeInMainWorld('${bridgeName}', ...) object ` +
            '(only plain identifier-keyed property assignments are modeled — extend ' +
            'extractExposedBridgeProperties).'
        );
      }
      return [property.name.text, property.initializer.getText(sourceFile)];
    })
  );
}

function requireExposedBridgeProperty(
  properties: ReadonlyMap<string, string>,
  bridgeName: string,
  propertyName: string
): string {
  const property = properties.get(propertyName);
  if (property === undefined) {
    throw new Error(
      `Missing '${propertyName}' in exposed '${bridgeName}' bridge. Available properties: ${[
        ...properties.keys(),
      ].join(', ')}`
    );
  }
  return property;
}

function extractExposedBridgeMethodNames(source: string, bridgeName: string): string[] {
  return [...extractExposedBridgeProperties(source, bridgeName).keys()];
}

function findRawIpcRendererChannels(source: string): string[] {
  const pattern = /ipcRenderer\.(?:invoke|send|on|removeListener)\(\s*['"][^'"]+['"]/g;
  return [...source.matchAll(pattern)].map((match) => {
    const lineNumber = source.slice(0, match.index).split('\n').length;
    return `${lineNumber}: ${match[0]}`;
  });
}

/** Every channel string the manifest owns, flattened across its groups. */
function listManifestChannels(): string[] {
  return Object.values(DESKTOP_IPC_CHANNELS).flatMap((group) => Object.values(group));
}

/** `line: 'channel'` for every manifest channel that appears as a literal in `source`. */
function findManifestChannelLiterals(source: string): string[] {
  const findings: string[] = [];
  for (const channel of listManifestChannels()) {
    for (const quote of ["'", '"']) {
      const literal = `${quote}${channel}${quote}`;
      let index = source.indexOf(literal);
      while (index !== -1) {
        findings.push(`${source.slice(0, index).split('\n').length}: ${literal}`);
        index = source.indexOf(literal, index + literal.length);
      }
    }
  }
  return findings.sort();
}

describe('preload runtime contract', () => {
  it('sources every channel from the desktop IPC manifest instead of a local literal', () => {
    // BST-1648: the manifest is the ONE place a channel string lives. The
    // preload imports it (bundle: true inlines the pure module) and the
    // AST walk in preload-sandbox-imports.test.ts proves the graph stays
    // sandbox-pure. A literal that equals any manifest channel is a
    // duplicate by definition.
    const preloadSource = readPreloadSource();
    expect(preloadSource).toContain("from './platform/desktop-ipc-channels'");
    const duplicatedLiterals = findManifestChannelLiterals(preloadSource);
    expect(duplicatedLiterals).toEqual([]);
    expect(preloadSource).not.toMatch(/['"]logging:[^'"]+['"]/);
  });

  it('keeps the E2E seed routing keys sourced from MAIN authority', () => {
    const preloadSource = readPreloadSource();
    expect(preloadSource).toContain("from './platform/desktop-storage-authority'");
    expect(preloadSource).toContain(
      'MAIN_OWNED_DESKTOP_STORAGE_KEYS_FOR_E2E = new Set<string>(MAIN_OWNED_DESKTOP_STORAGE_KEYS)'
    );
  });

  it('keeps deterministic E2E local-runtime bridge responses in preload', () => {
    const preloadSource = readPreloadSource();

    expect(preloadSource).toContain('BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES');
    expect(preloadSource).toContain('createDisabledLocalRuntimeAvailability');
    expect(preloadSource).toContain('createDisabledLocalRuntimeCatalog');
  });

  it('keeps the desktop diagnostics bridge on the manifest channel', () => {
    const preloadSource = readPreloadSource();
    const bridge = extractExposedBridgeProperties(preloadSource, 'desktopDiagnostics');
    expect(requireExposedBridgeProperty(bridge, 'desktopDiagnostics', 'getSnapshot')).toContain(
      'ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.diagnostics.getSnapshot)'
    );
  });

  it('keeps the MCP bridge shape on manifest channels with no raw invoke escape hatch', () => {
    const preloadSource = readPreloadSource();
    const mcpBridge = extractExposedBridgeProperties(preloadSource, 'mcp');
    const appsBridge = requireExposedBridgeProperty(mcpBridge, 'mcp', 'apps');
    expect(appsBridge).toContain(
      'ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.appsPrepare, request)'
    );
    expect(appsBridge).toContain(
      'ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.appsExecute, request)'
    );
    expect(appsBridge).toContain(
      'ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.appsRelease, request)'
    );
    expect(appsBridge).toContain('readMcpAppResource(origin)');
    expect(requireExposedBridgeProperty(mcpBridge, 'mcp', 'getServerStatusSnapshot')).toContain(
      'ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.statusGet)'
    );
    const statusSubscription = requireExposedBridgeProperty(
      mcpBridge,
      'mcp',
      'onServerStatusUpdated'
    );
    expect(statusSubscription).toContain(
      'ipcRenderer.on(DESKTOP_IPC_CHANNELS.mcp.statusUpdated, listener)'
    );
    expect(statusSubscription).toContain(
      'ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.mcp.statusUpdated, listener)'
    );
    // BST-1585: content browsing crosses IPC as three verb-specific channels;
    // the renderer never gets a raw `invoke(method, params)` escape hatch.
    expect(requireExposedBridgeProperty(mcpBridge, 'mcp', 'readResource')).toContain(
      'ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.contentReadResource, request)'
    );
    expect(requireExposedBridgeProperty(mcpBridge, 'mcp', 'getPrompt')).toContain(
      'ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.contentGetPrompt, request)'
    );
    expect(requireExposedBridgeProperty(mcpBridge, 'mcp', 'complete')).toContain(
      'ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.contentComplete, request)'
    );
    expect([...mcpBridge.keys()]).not.toContain('invoke');
    expect(requireExposedBridgeProperty(mcpBridge, 'mcp', 'settleElicitation')).toContain(
      'ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.elicitationSettle, settlement)'
    );
    for (const [property, member] of [
      ['onElicitationRequested', 'DESKTOP_IPC_CHANNELS.mcp.elicitationRequested'],
      ['onElicitationRetired', 'DESKTOP_IPC_CHANNELS.mcp.elicitationRetired'],
    ] as const) {
      const subscription = requireExposedBridgeProperty(mcpBridge, 'mcp', property);
      expect(subscription).toContain(`ipcRenderer.on(${member}, listener)`);
      expect(subscription).toContain(`ipcRenderer.removeListener(${member}, listener)`);
    }
    // Durable MCP Tasks bridge (BST-1566): act/list invokes plus the status push.
    const tasksBridge = requireExposedBridgeProperty(mcpBridge, 'mcp', 'tasks');
    expect(tasksBridge).toContain('ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.taskAct, request)');
    expect(tasksBridge).toContain('ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mcp.taskList)');
    expect(tasksBridge).toContain(
      'ipcRenderer.on(DESKTOP_IPC_CHANNELS.mcp.taskStatusChanged, listener)'
    );
    expect(tasksBridge).toContain(
      'ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.mcp.taskStatusChanged, listener)'
    );
  });

  it('keeps resolver-gated bridge key sets in parity with their required-method contracts', () => {
    const preloadSource = readPreloadSource();
    // Each of these bridges is disabled WHOLESALE by its resolver when any
    // required method is missing from the preload surface, so the exposed key
    // set must match the resolver's required-method list exactly. Domains
    // migrated to contract modules (BST-1648) are pinned by key-set equality
    // in preload-contract-bridges.test.ts + ipc-domains/leaf-contracts.test.ts
    // instead of this source walk.
    const expectedBridgeMethods: Record<string, readonly string[]> = {
      browser: BROWSER_BRIDGE_REQUIRED_METHODS,
      envBootstrap: ENV_BOOTSTRAP_BRIDGE_REQUIRED_METHODS,
      platform: PLATFORM_BRIDGE_REQUIRED_METHODS,
      providerAuth: PROVIDER_AUTH_BRIDGE_REQUIRED_METHODS,
      secrets: SECRETS_BRIDGE_REQUIRED_METHODS,
      workspace: WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS,
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
