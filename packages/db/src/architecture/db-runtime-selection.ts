import type { ProfileBootstrapRuntime } from '../bootstrap/profile-bootstrap-report.js';

export type BrainstrikeDbRuntimeEngine = 'pglite' | 'turso';

export type BrainstrikeDbRuntimePlatform = 'desktop' | 'node-test' | 'web';

export type BrainstrikeDbRuntimeSelectionSource = 'config' | 'default' | 'env' | 'test';

export interface BrainstrikeDbRuntimeSelection {
  readonly bootstrapRuntime: ProfileBootstrapRuntime;
  readonly engine: BrainstrikeDbRuntimeEngine;
  readonly platform: BrainstrikeDbRuntimePlatform;
  readonly source: BrainstrikeDbRuntimeSelectionSource;
}

export interface BrainstrikeDbRuntimeSelectionInput {
  readonly platform: BrainstrikeDbRuntimePlatform;
  readonly requestedEngine?: unknown;
  readonly source?: BrainstrikeDbRuntimeSelectionSource;
}

export interface BrainstrikeDbRuntimeSelectionErrorDetails {
  readonly code: 'turso_runtime_platform_unsupported' | 'unsupported_db_runtime';
  readonly platform: BrainstrikeDbRuntimePlatform;
  readonly requestedEngine: unknown;
  readonly source: BrainstrikeDbRuntimeSelectionSource;
}

export class BrainstrikeDbRuntimeSelectionError extends Error {
  readonly code: BrainstrikeDbRuntimeSelectionErrorDetails['code'];
  readonly platform: BrainstrikeDbRuntimePlatform;
  readonly requestedEngine: unknown;
  readonly source: BrainstrikeDbRuntimeSelectionSource;

  constructor(message: string, details: BrainstrikeDbRuntimeSelectionErrorDetails) {
    super(message);
    this.name = 'BrainstrikeDbRuntimeSelectionError';
    this.code = details.code;
    this.platform = details.platform;
    this.requestedEngine = details.requestedEngine;
    this.source = details.source;
  }
}

export function resolveBrainstrikeDbRuntimeSelection(
  input: BrainstrikeDbRuntimeSelectionInput
): BrainstrikeDbRuntimeSelection {
  const source = input.source ?? (input.requestedEngine === undefined ? 'default' : 'config');
  const engine = parseRequestedRuntimeEngine(input, source);

  if (engine === 'turso' && input.platform === 'node-test') {
    throw new BrainstrikeDbRuntimeSelectionError(
      'Turso DB runtime is unsupported on node-test. Browser Turso requires the browser WASM runtime; desktop Turso requires the desktop owner client.',
      {
        code: 'turso_runtime_platform_unsupported',
        platform: input.platform,
        requestedEngine: input.requestedEngine,
        source,
      }
    );
  }

  return {
    bootstrapRuntime: runtimeForSelection(engine, input.platform),
    engine,
    platform: input.platform,
    source,
  };
}

function parseRequestedRuntimeEngine(
  input: BrainstrikeDbRuntimeSelectionInput,
  source: BrainstrikeDbRuntimeSelectionSource
): BrainstrikeDbRuntimeEngine {
  if (input.requestedEngine === undefined) {
    return defaultRuntimeEngineForPlatform(input.platform);
  }

  if (input.requestedEngine === 'pglite' || input.requestedEngine === 'turso') {
    return input.requestedEngine;
  }

  throw new BrainstrikeDbRuntimeSelectionError(
    `Unsupported Brainstrike DB runtime: ${String(input.requestedEngine)}`,
    {
      code: 'unsupported_db_runtime',
      platform: input.platform,
      requestedEngine: input.requestedEngine,
      source,
    }
  );
}

function defaultRuntimeEngineForPlatform(
  platform: BrainstrikeDbRuntimePlatform
): BrainstrikeDbRuntimeEngine {
  switch (platform) {
    case 'desktop':
      return 'turso';
    case 'node-test':
    case 'web':
      return 'pglite';
    default:
      return assertUnreachableRuntimePlatform(platform);
  }
}

function runtimeForSelection(
  engine: BrainstrikeDbRuntimeEngine,
  platform: BrainstrikeDbRuntimePlatform
): ProfileBootstrapRuntime {
  switch (platform) {
    case 'desktop':
      return {
        engine,
        host: 'electron-utility',
        persistence: 'filesystem',
      };
    case 'web':
      if (engine === 'turso') {
        return {
          engine,
          host: 'browser',
          persistence: 'opfs',
        };
      }
      return {
        engine,
        host: 'worker',
        persistence: 'idb',
      };
    case 'node-test':
      return {
        engine,
        host: 'node',
        persistence: engine === 'pglite' ? 'memory' : 'filesystem',
      };
    default:
      return assertUnreachableRuntimePlatform(platform);
  }
}

function assertUnreachableRuntimePlatform(value: never): never {
  throw new Error(`Unhandled Brainstrike DB runtime platform: ${String(value)}`);
}
