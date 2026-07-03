import {
  BrainstrikeDbRuntimeSelectionError,
  resolveBrainstrikeDbRuntimeSelection,
} from '../src/architecture/db-runtime-selection.js';

describe('Brainstrike DB runtime selection', () => {
  it('defaults desktop to the Turso filesystem runtime', () => {
    expect(resolveBrainstrikeDbRuntimeSelection({ platform: 'desktop' })).toEqual({
      bootstrapRuntime: {
        engine: 'turso',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      engine: 'turso',
      platform: 'desktop',
      source: 'default',
    });
  });

  it('keeps web on the existing PGlite IndexedDB runtime by default', () => {
    expect(resolveBrainstrikeDbRuntimeSelection({ platform: 'web' })).toEqual({
      bootstrapRuntime: {
        engine: 'pglite',
        host: 'worker',
        persistence: 'idb',
      },
      engine: 'pglite',
      platform: 'web',
      source: 'default',
    });
  });

  it('keeps node-test on the existing PGlite memory runtime by default', () => {
    expect(resolveBrainstrikeDbRuntimeSelection({ platform: 'node-test' })).toEqual({
      bootstrapRuntime: {
        engine: 'pglite',
        host: 'node',
        persistence: 'memory',
      },
      engine: 'pglite',
      platform: 'node-test',
      source: 'default',
    });
  });

  it('preserves caller provenance when the desktop runtime defaults to Turso', () => {
    expect(resolveBrainstrikeDbRuntimeSelection({ platform: 'desktop', source: 'env' })).toEqual({
      bootstrapRuntime: {
        engine: 'turso',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      engine: 'turso',
      platform: 'desktop',
      source: 'env',
    });
  });

  it('keeps explicit PGlite opt-in available on desktop', () => {
    expect(
      resolveBrainstrikeDbRuntimeSelection({
        platform: 'desktop',
        requestedEngine: 'pglite',
        source: 'env',
      })
    ).toEqual({
      bootstrapRuntime: {
        engine: 'pglite',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      engine: 'pglite',
      platform: 'desktop',
      source: 'env',
    });
  });

  it('allows an explicit Turso runtime only on desktop', () => {
    expect(
      resolveBrainstrikeDbRuntimeSelection({
        platform: 'desktop',
        requestedEngine: 'turso',
        source: 'env',
      })
    ).toEqual({
      bootstrapRuntime: {
        engine: 'turso',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      engine: 'turso',
      platform: 'desktop',
      source: 'env',
    });
  });

  it.each([
    'node-test',
    'web',
  ] as const)('rejects Turso on %s instead of falling back to PGlite', (platform) => {
    expectSelectionError(
      () =>
        resolveBrainstrikeDbRuntimeSelection({
          platform,
          requestedEngine: 'turso',
          source: 'env',
        }),
      {
        code: 'turso_runtime_platform_unsupported',
        message:
          'Turso DB runtime is desktop-only until Brainstrike wires a production adapter behind the desktop host.',
        platform,
        requestedEngine: 'turso',
        source: 'env',
      }
    );
  });

  it('reports config provenance for explicit runtime values without an explicit source', () => {
    expectSelectionError(
      () =>
        resolveBrainstrikeDbRuntimeSelection({
          platform: 'desktop',
          requestedEngine: 'sqlite',
        }),
      {
        code: 'unsupported_db_runtime',
        message: 'Unsupported Brainstrike DB runtime: sqlite',
        platform: 'desktop',
        requestedEngine: 'sqlite',
        source: 'config',
      }
    );
  });

  it('rejects unknown runtime values instead of silently degrading', () => {
    expectSelectionError(
      () =>
        resolveBrainstrikeDbRuntimeSelection({
          platform: 'desktop',
          requestedEngine: 'sqlite',
          source: 'env',
        }),
      {
        code: 'unsupported_db_runtime',
        message: 'Unsupported Brainstrike DB runtime: sqlite',
        platform: 'desktop',
        requestedEngine: 'sqlite',
        source: 'env',
      }
    );
  });
});

function expectSelectionError(
  callback: () => unknown,
  expected: {
    readonly code: BrainstrikeDbRuntimeSelectionError['code'];
    readonly message: string;
    readonly platform: BrainstrikeDbRuntimeSelectionError['platform'];
    readonly requestedEngine: unknown;
    readonly source: BrainstrikeDbRuntimeSelectionError['source'];
  }
): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(BrainstrikeDbRuntimeSelectionError);
    expect(error).toMatchObject(expected);
    return;
  }

  throw new Error('Expected runtime selection to throw.');
}
