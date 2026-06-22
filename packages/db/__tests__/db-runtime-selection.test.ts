import {
  BrainstrikeDbRuntimeSelectionError,
  resolveBrainstrikeDbRuntimeSelection,
} from '../src/architecture/db-runtime-selection.js';

describe('Brainstrike DB runtime selection', () => {
  it('keeps desktop on the existing PGlite filesystem runtime by default', () => {
    expect(resolveBrainstrikeDbRuntimeSelection({ platform: 'desktop' })).toEqual({
      bootstrapRuntime: {
        engine: 'pglite',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      engine: 'pglite',
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

  it('rejects Turso on web instead of falling back to PGlite', () => {
    expectSelectionError(
      () =>
        resolveBrainstrikeDbRuntimeSelection({
          platform: 'web',
          requestedEngine: 'turso',
          source: 'env',
        }),
      {
        code: 'turso_runtime_web_unsupported',
        message: 'Turso DB runtime is desktop-only because the JavaScript package is Node-only.',
        platform: 'web',
        requestedEngine: 'turso',
        source: 'env',
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
